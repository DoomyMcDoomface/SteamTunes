/* WASAPI interop for the game audio envelope helper.
 *
 * Two separate jobs live here:
 *
 *   AudioSessions   - enumerates audio sessions on the default render device to
 *                     work out which process is worth listening to.
 *   LoopbackCapture - captures a process tree's rendered audio via
 *                     ActivateAudioInterfaceAsync with process loopback
 *                     activation, which needs Windows 10 build 20348 or later.
 *
 * C# 5 only, so this can be built with the in-box .NET Framework compiler.
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace SteamMusicPlayer
{
	/* Picks the process to measure.
	 *
	 * Anything in the Steam family is discarded, which is what keeps the music
	 * out of its own sidechain, and of what remains the session with the highest
	 * current peak wins. The peak meter is only used to choose between
	 * candidates - the actual measurement is done properly on captured samples.
	 */
	internal struct SessionScan
	{
		public int BestPid;
		public float BestPeak;

		// Peak of the process currently being captured, so the caller can tell
		// "something else is louder now" from "the same thing got louder".
		public float CurrentPeak;

		public bool BestIsGame;
	}

	/* Decides whether a process is the game.
	 *
	 * Only executables under a Steam library's steamapps\common directory
	 * count. Voice chat, browsers, and anything else are ignored even if they
	 * are louder and even if Steam says a game is running. Discord is also
	 * rejected by process name so it can never be treated as a game.
	 */
	internal sealed class GameIdentifier
	{
		private const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

		private static readonly string[] NeverGame = new string[]
		{
			"discord",
			"discordptb",
			"discordcanary",
			"discorddevelopment",
		};

		private readonly List<string> _gameRoots = new List<string>();
		private readonly Dictionary<int, bool> _verdictCache = new Dictionary<int, bool>();

		public GameIdentifier(string steamPath)
		{
			// The caller passes the install path it already knows, but a path
			// with spaces is easy to mangle on the way here and a wrong path
			// silently leaves no roots at all, which would disable detection.
			// Steam records its own location, so that is the safer source and
			// the argument is only a hint.
			if (!HasCommonDirectory(steamPath))
			{
				steamPath = InstallPathFromRegistry() ?? steamPath;
			}

			AddRoot(steamPath);
			foreach (string libraryPath in ReadLibraryFolders(steamPath))
			{
				AddRoot(libraryPath);
			}
		}

		private static bool HasCommonDirectory(string libraryPath)
		{
			if (string.IsNullOrEmpty(libraryPath))
			{
				return false;
			}
			try
			{
				return Directory.Exists(Path.Combine(Path.Combine(libraryPath, "steamapps"), "common"));
			}
			catch
			{
				return false;
			}
		}

		private static string InstallPathFromRegistry()
		{
			// SteamPath is the per-user value and uses forward slashes;
			// InstallPath under the 32-bit machine hive is the fallback.
			try
			{
				using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
				{
					if (key != null)
					{
						string path = key.GetValue("SteamPath") as string;
						if (!string.IsNullOrEmpty(path))
						{
							return path.Replace('/', '\\');
						}
					}
				}
			}
			catch
			{
				/* fall through to the machine hive */
			}

			try
			{
				using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Valve\Steam"))
				{
					if (key != null)
					{
						string path = key.GetValue("InstallPath") as string;
						if (!string.IsNullOrEmpty(path))
						{
							return path.Replace('/', '\\');
						}
					}
				}
			}
			catch
			{
				/* no usable path; the caller's hint is all there is */
			}

			return null;
		}

		public IEnumerable<string> Roots
		{
			get { return _gameRoots; }
		}

		private void AddRoot(string libraryPath)
		{
			if (string.IsNullOrEmpty(libraryPath))
			{
				return;
			}
			try
			{
				// Paths arrive in whatever spelling their source used: the vdf
				// uses backslashes, Millennium hands over forward slashes, and
				// the registry mixes both. Process paths from the OS are always
				// backslashed, so a root has to be canonicalised or the
				// StartsWith test below silently never matches it.
				string common = Path.GetFullPath(
					Path.Combine(Path.Combine(libraryPath.Replace('/', '\\'), "steamapps"), "common"));
				if (!Directory.Exists(common))
				{
					return;
				}
				// The same library can arrive twice with different casing, since
				// one spelling comes from the registry and one from the vdf.
				for (int i = 0; i < _gameRoots.Count; i++)
				{
					if (string.Equals(_gameRoots[i], common, StringComparison.OrdinalIgnoreCase))
					{
						return;
					}
				}
				_gameRoots.Add(common);
			}
			catch
			{
				/* a malformed path in the vdf is not fatal */
			}
		}

		private static IEnumerable<string> ReadLibraryFolders(string steamPath)
		{
			List<string> paths = new List<string>();
			try
			{
				string vdf = Path.Combine(Path.Combine(steamPath, "steamapps"), "libraryfolders.vdf");
				if (!File.Exists(vdf))
				{
					return paths;
				}
				foreach (string line in File.ReadAllLines(vdf))
				{
					// Lines look like:   "path"  "D:\\SteamLibrary"
					int keyStart = line.IndexOf("\"path\"", StringComparison.OrdinalIgnoreCase);
					if (keyStart < 0)
					{
						continue;
					}
					int valueStart = line.IndexOf('"', keyStart + 6);
					if (valueStart < 0)
					{
						continue;
					}
					int valueEnd = line.IndexOf('"', valueStart + 1);
					if (valueEnd < 0)
					{
						continue;
					}
					paths.Add(line.Substring(valueStart + 1, valueEnd - valueStart - 1).Replace("\\\\", "\\"));
				}
			}
			catch
			{
				/* fall back to the primary library only */
			}
			return paths;
		}

		// Non-zero while Steam considers a game to be running.
		public static int RunningAppId()
		{
			try
			{
				using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
				{
					if (key == null)
					{
						return 0;
					}
					object value = key.GetValue("RunningAppID");
					return value == null ? 0 : Convert.ToInt32(value);
				}
			}
			catch
			{
				return 0;
			}
		}

		public bool LooksLikeGame(int pid)
		{
			bool cached;
			if (_verdictCache.TryGetValue(pid, out cached))
			{
				return cached;
			}

			if (IsNeverGame(pid))
			{
				_verdictCache[pid] = false;
				return false;
			}

			string path = ExecutablePath(pid);
			bool verdict = false;
			if (!string.IsNullOrEmpty(path))
			{
				for (int i = 0; i < _gameRoots.Count; i++)
				{
					if (path.StartsWith(_gameRoots[i], StringComparison.OrdinalIgnoreCase))
					{
						verdict = true;
						break;
					}
				}
			}

			// Pids are recycled, but not within the lifetime of one capture
			// session, and the cache is cheap insurance against querying the
			// same process every few seconds.
			if (_verdictCache.Count > 256)
			{
				_verdictCache.Clear();
			}
			_verdictCache[pid] = verdict;
			return verdict;
		}

		private static bool IsNeverGame(int pid)
		{
			try
			{
				string name = Process.GetProcessById(pid).ProcessName;
				for (int i = 0; i < NeverGame.Length; i++)
				{
					if (string.Equals(name, NeverGame[i], StringComparison.OrdinalIgnoreCase))
					{
						return true;
					}
				}
			}
			catch
			{
				/* a process we cannot name is handled by the path test */
			}
			return false;
		}

		/* QueryFullProcessImageName rather than Process.MainModule: the limited
		 * information right is enough for it, so it still works for processes
		 * this one could not otherwise open - which includes plenty of games. */
		private static string ExecutablePath(int pid)
		{
			IntPtr handle = IntPtr.Zero;
			try
			{
				handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
				if (handle == IntPtr.Zero)
				{
					return null;
				}
				StringBuilder buffer = new StringBuilder(1024);
				int size = buffer.Capacity;
				if (!QueryFullProcessImageName(handle, 0, buffer, ref size))
				{
					return null;
				}
				return buffer.ToString();
			}
			catch
			{
				return null;
			}
			finally
			{
				if (handle != IntPtr.Zero)
				{
					CloseHandle(handle);
				}
			}
		}

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern IntPtr OpenProcess(int desiredAccess, bool inheritHandle, int processId);

		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
		private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder exeName, ref int size);

		[DllImport("kernel32.dll", SetLastError = true)]
		private static extern bool CloseHandle(IntPtr handle);
	}

	internal static class AudioSessions
	{
		public static SessionScan Scan(string[] excludedNames, int currentPid, GameIdentifier games)
		{
			SessionScan result = new SessionScan();
			result.BestPeak = -1f;

			IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
			IMMDevice device = null;
			object sessionManagerObject = null;

			try
			{
				int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device);
				if (hr != 0 || device == null)
				{
					return result;
				}

				Guid managerIid = typeof(IAudioSessionManager2).GUID;
				hr = device.Activate(ref managerIid, 0 /* CLSCTX_INPROC_SERVER */, IntPtr.Zero, out sessionManagerObject);
				if (hr != 0 || sessionManagerObject == null)
				{
					return result;
				}

				IAudioSessionManager2 manager = (IAudioSessionManager2)sessionManagerObject;
				IAudioSessionEnumerator sessions;
				if (manager.GetSessionEnumerator(out sessions) != 0 || sessions == null)
				{
					return result;
				}

				int count;
				if (sessions.GetCount(out count) != 0)
				{
					return result;
				}

				int bestGamePid = 0;
				float bestGamePeak = -1f;

				for (int i = 0; i < count; i++)
				{
					IAudioSessionControl control = null;
					try
					{
						if (sessions.GetSession(i, out control) != 0 || control == null)
						{
							continue;
						}

						AudioSessionState state;
						if (control.GetState(out state) != 0 || state != AudioSessionState.Active)
						{
							continue;
						}

						IAudioSessionControl2 control2 = control as IAudioSessionControl2;
						if (control2 == null)
						{
							continue;
						}

						uint pid;
						if (control2.GetProcessId(out pid) != 0 || pid == 0)
						{
							continue;
						}

						// The system sounds session reports as a session with no
						// real owning process; it is never the game.
						if (control2.IsSystemSoundsSession() == 0)
						{
							continue;
						}

						if (IsExcluded((int)pid, excludedNames))
						{
							continue;
						}

						float peak = 0f;
						IAudioMeterInformation meter = control as IAudioMeterInformation;
						if (meter != null)
						{
							meter.GetPeakValue(out peak);
						}

						if ((int)pid == currentPid && peak > result.CurrentPeak)
						{
							result.CurrentPeak = peak;
						}

						if (games.LooksLikeGame((int)pid) && peak > bestGamePeak)
						{
							bestGamePeak = peak;
							bestGamePid = (int)pid;
						}
					}
					finally
					{
						if (control != null)
						{
							Marshal.ReleaseComObject(control);
						}
					}
				}

				// Only a confirmed game is ever captured. Discord, browsers, and
				// anything else stay ignored even while Steam says a game is
				// running - that fallback was latching onto voice chat.
				if (bestGamePid != 0)
				{
					result.BestPid = bestGamePid;
					result.BestPeak = bestGamePeak;
					result.BestIsGame = true;
				}

				return result;
			}
			finally
			{
				if (sessionManagerObject != null)
				{
					Marshal.ReleaseComObject(sessionManagerObject);
				}
				if (device != null)
				{
					Marshal.ReleaseComObject(device);
				}
				Marshal.ReleaseComObject(enumerator);
			}
		}

		private static bool IsExcluded(int pid, string[] excludedNames)
		{
			string name;
			try
			{
				name = Process.GetProcessById(pid).ProcessName;
			}
			catch
			{
				// A process that cannot be inspected cannot be confirmed safe to
				// capture, and capturing the player's own output would be worse
				// than missing a duck.
				return true;
			}

			for (int i = 0; i < excludedNames.Length; i++)
			{
				if (string.Equals(name, excludedNames[i], StringComparison.OrdinalIgnoreCase))
				{
					return true;
				}
			}
			return false;
		}
	}

	internal sealed class LoopbackCapture : IDisposable
	{
		private const string VirtualLoopbackDevice = "VAD\\Process_Loopback";

		private const int AUDCLNT_SHAREMODE_SHARED = 0;
		private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
		private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
		private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

		// 20 ms, in 100 ns units, matching Microsoft's process loopback sample.
		private const long BufferDuration = 200000;

		private IAudioClient _client;
		private IAudioCaptureClient _capture;
		private EventWaitHandle _bufferReady;
		private float[] _scratch;

		public int SampleRate { get; private set; }
		public int Channels { get; private set; }

		// Frames consumed by the most recent Pump, for health logging.
		public int LastFrameCount { get; private set; }

		public void Start(int processId)
		{
			// The virtual loopback device exposes no mix format of its own, so a
			// format is requested rather than negotiated. 16-bit stereo at 44.1
			// kHz is what the Microsoft sample uses and is accepted reliably;
			// the measurement derives its filter coefficients from whatever rate
			// ends up here, so this choice only affects resolution, not
			// correctness.
			WAVEFORMATEX format = new WAVEFORMATEX();
			format.wFormatTag = 1; // WAVE_FORMAT_PCM
			format.nChannels = 2;
			format.nSamplesPerSec = 44100;
			format.wBitsPerSample = 16;
			format.nBlockAlign = (ushort)(format.nChannels * format.wBitsPerSample / 8);
			format.nAvgBytesPerSec = (uint)(format.nSamplesPerSec * format.nBlockAlign);
			format.cbSize = 0;

			SampleRate = (int)format.nSamplesPerSec;
			Channels = format.nChannels;

			_client = ActivateProcessLoopback(processId);

			IntPtr formatPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEFORMATEX)));
			try
			{
				Marshal.StructureToPtr(format, formatPtr, false);
				int hr = _client.Initialize(
					AUDCLNT_SHAREMODE_SHARED,
					AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
					BufferDuration,
					0,
					formatPtr,
					IntPtr.Zero);
				Check(hr, "IAudioClient.Initialize");
			}
			finally
			{
				Marshal.FreeHGlobal(formatPtr);
			}

			_bufferReady = new EventWaitHandle(false, EventResetMode.AutoReset);
			Check(_client.SetEventHandle(_bufferReady.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");

			Guid captureIid = typeof(IAudioCaptureClient).GUID;
			object captureObject;
			Check(_client.GetService(ref captureIid, out captureObject), "GetService(IAudioCaptureClient)");
			_capture = (IAudioCaptureClient)captureObject;

			Check(_client.Start(), "IAudioClient.Start");
		}

		/* Names the step and keeps the raw HRESULT, since the WASAPI-specific
		 * codes (AUDCLNT_E_UNSUPPORTED_FORMAT and friends) are the whole
		 * diagnosis and a generic COMException message hides them. */
		private static void Check(int hr, string what)
		{
			if (hr != 0)
			{
				throw new InvalidOperationException(what + " failed with 0x" + hr.ToString("X8"));
			}
		}

		private static IAudioClient ActivateProcessLoopback(int processId)
		{
			AUDIOCLIENT_ACTIVATION_PARAMS activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS();
			activationParams.ActivationType = 1; // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
			activationParams.TargetProcessId = (uint)processId;
			activationParams.ProcessLoopbackMode = 0; // INCLUDE_TARGET_PROCESS_TREE

			int paramsSize = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
			IntPtr paramsPtr = Marshal.AllocHGlobal(paramsSize);
			IntPtr propVariantPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PROPVARIANT_BLOB)));

			try
			{
				Marshal.StructureToPtr(activationParams, paramsPtr, false);

				PROPVARIANT_BLOB propVariant = new PROPVARIANT_BLOB();
				propVariant.vt = 65; // VT_BLOB
				propVariant.cbSize = paramsSize;
				propVariant.pBlobData = paramsPtr;
				Marshal.StructureToPtr(propVariant, propVariantPtr, false);

				Guid audioClientIid = typeof(IAudioClient).GUID;
				ActivationHandler handler = new ActivationHandler();
				IActivateAudioInterfaceAsyncOperation operation;

				Check(NativeMethods.ActivateAudioInterfaceAsync(
					VirtualLoopbackDevice,
					ref audioClientIid,
					propVariantPtr,
					handler,
					out operation), "ActivateAudioInterfaceAsync");

				if (!handler.Completed.WaitOne(4000))
				{
					throw new TimeoutException("process loopback activation did not complete");
				}

				int activateResult;
				object activatedInterface;
				Check(operation.GetActivateResult(out activateResult, out activatedInterface), "GetActivateResult");
				Check(activateResult, "process loopback activation");

				return (IAudioClient)activatedInterface;
			}
			finally
			{
				Marshal.FreeHGlobal(propVariantPtr);
				Marshal.FreeHGlobal(paramsPtr);
			}
		}

		/* Drains whatever is available into the meter. Returns false when the
		 * target rendered nothing, which is normal - a silent process delivers
		 * no packets at all rather than delivering zeroes. */
		public bool Pump(LoudnessMeter meter)
		{
			LastFrameCount = 0;
			if (_capture == null)
			{
				return false;
			}

			// Waiting on the buffer-ready event rather than spinning, with a
			// timeout because that event never fires while the target is silent.
			_bufferReady.WaitOne(50);

			bool sawAudio = false;
			uint packetFrames;
			while (_capture.GetNextPacketSize(out packetFrames) == 0 && packetFrames > 0)
			{
				IntPtr data;
				uint framesAvailable;
				uint flags;
				long devicePosition;
				long qpcPosition;

				int hr = _capture.GetBuffer(out data, out framesAvailable, out flags, out devicePosition, out qpcPosition);
				if (hr != 0)
				{
					break;
				}

				try
				{
					if (framesAvailable > 0)
					{
						sawAudio = true;
						LastFrameCount += (int)framesAvailable;
						if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
						{
							// The buffer contents are undefined when the silent
							// flag is set, so it is measured as true silence.
							meter.AddSamples(EnsureScratch((int)framesAvailable * Channels, true), (int)framesAvailable);
						}
						else
						{
							int sampleCount = (int)framesAvailable * Channels;
							float[] scratch = EnsureScratch(sampleCount, false);
							for (int i = 0; i < sampleCount; i++)
							{
								scratch[i] = Marshal.ReadInt16(data, i * 2) / 32768f;
							}
							meter.AddSamples(scratch, (int)framesAvailable);
						}
					}
				}
				finally
				{
					_capture.ReleaseBuffer(framesAvailable);
				}
			}

			return sawAudio;
		}

		private float[] EnsureScratch(int size, bool zeroed)
		{
			if (_scratch == null || _scratch.Length < size)
			{
				_scratch = new float[Math.Max(size, 8192)];
			}
			else if (zeroed)
			{
				Array.Clear(_scratch, 0, size);
			}
			return _scratch;
		}

		public void Dispose()
		{
			if (_client != null)
			{
				try
				{
					_client.Stop();
				}
				catch
				{
					/* stopping a dead client is not interesting */
				}
			}
			if (_capture != null)
			{
				Marshal.ReleaseComObject(_capture);
				_capture = null;
			}
			if (_client != null)
			{
				Marshal.ReleaseComObject(_client);
				_client = null;
			}
			if (_bufferReady != null)
			{
				_bufferReady.Close();
				_bufferReady = null;
			}
		}
	}

	/* ActivateAudioInterfaceAsync hands its result to this rather than
	 * returning it, so activation is turned back into a blocking call.
	 *
	 * IAgileObject is not optional. Windows invokes ActivateCompleted from a
	 * worker thread in the MTA, and it will not proceed unless the handler
	 * declares itself apartment-agnostic - implementing only the completion
	 * handler interface makes ActivateAudioInterfaceAsync fail immediately with
	 * E_ILLEGAL_METHOD_CALL and no indication of the cause. IAgileObject has no
	 * methods; it exists purely as that promise. */
	[ComVisible(true)]
	internal sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
	{
		public readonly ManualResetEvent Completed = new ManualResetEvent(false);

		public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
		{
			Completed.Set();
		}
	}

	internal static class NativeMethods
	{
		// PreserveSig stays on (the default) so the HRESULT comes back as a
		// return value and activation failures can be reported with the pid that
		// caused them, rather than surfacing as a bare exception.
		[DllImport("Mmdevapi.dll", ExactSpelling = true)]
		public static extern int ActivateAudioInterfaceAsync(
			[MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
			ref Guid riid,
			IntPtr activationParams,
			IActivateAudioInterfaceCompletionHandler completionHandler,
			out IActivateAudioInterfaceAsyncOperation activationOperation);
	}

	[StructLayout(LayoutKind.Sequential)]
	internal struct AUDIOCLIENT_ACTIVATION_PARAMS
	{
		public int ActivationType;
		public uint TargetProcessId;
		public int ProcessLoopbackMode;
	}

	/* PROPVARIANT, but only ever used to carry a VT_BLOB. The explicit padding
	 * matters: the union begins at offset 8, and on 64-bit the blob's pointer is
	 * 8-byte aligned, so it lands at offset 16 rather than 12. */
	[StructLayout(LayoutKind.Sequential)]
	internal struct PROPVARIANT_BLOB
	{
		public ushort vt;
		public ushort wReserved1;
		public ushort wReserved2;
		public ushort wReserved3;
		public int cbSize;
		public int padding;
		public IntPtr pBlobData;
	}

	[StructLayout(LayoutKind.Sequential, Pack = 2)]
	internal struct WAVEFORMATEX
	{
		public ushort wFormatTag;
		public ushort nChannels;
		public uint nSamplesPerSec;
		public uint nAvgBytesPerSec;
		public ushort nBlockAlign;
		public ushort wBitsPerSample;
		public ushort cbSize;
	}

	internal enum EDataFlow
	{
		eRender = 0,
		eCapture = 1,
		eAll = 2,
	}

	internal enum ERole
	{
		eConsole = 0,
		eMultimedia = 1,
		eCommunications = 2,
	}

	internal enum AudioSessionState
	{
		Inactive = 0,
		Active = 1,
		Expired = 2,
	}

	[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
	internal class MMDeviceEnumerator
	{
	}

	[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IMMDeviceEnumerator
	{
		[PreserveSig]
		int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IntPtr devices);

		[PreserveSig]
		int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
	}

	[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IMMDevice
	{
		[PreserveSig]
		int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object result);
	}

	[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioSessionManager2
	{
		// IAudioSessionManager
		[PreserveSig]
		int GetAudioSessionControl(IntPtr sessionGuid, uint streamFlags, out IAudioSessionControl sessionControl);

		[PreserveSig]
		int GetSimpleAudioVolume(IntPtr sessionGuid, uint streamFlags, out IntPtr audioVolume);

		// IAudioSessionManager2
		[PreserveSig]
		int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
	}

	[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioSessionEnumerator
	{
		[PreserveSig]
		int GetCount(out int sessionCount);

		[PreserveSig]
		int GetSession(int sessionIndex, out IAudioSessionControl session);
	}

	[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioSessionControl
	{
		[PreserveSig]
		int GetState(out AudioSessionState state);

		[PreserveSig]
		int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
	}

	[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioSessionControl2
	{
		// IAudioSessionControl
		[PreserveSig]
		int GetState(out AudioSessionState state);

		[PreserveSig]
		int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);

		[PreserveSig]
		int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);

		[PreserveSig]
		int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);

		[PreserveSig]
		int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);

		[PreserveSig]
		int GetGroupingParam(out Guid groupingParam);

		[PreserveSig]
		int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);

		[PreserveSig]
		int RegisterAudioSessionNotification(IntPtr newNotifications);

		[PreserveSig]
		int UnregisterAudioSessionNotification(IntPtr newNotifications);

		// IAudioSessionControl2
		[PreserveSig]
		int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);

		[PreserveSig]
		int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);

		[PreserveSig]
		int GetProcessId(out uint retVal);

		// S_OK when this *is* the system sounds session, S_FALSE when it is not.
		[PreserveSig]
		int IsSystemSoundsSession();

		[PreserveSig]
		int SetDuckingPreference(bool optOut);
	}

	[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioMeterInformation
	{
		[PreserveSig]
		int GetPeakValue(out float peak);
	}

	[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioClient
	{
		[PreserveSig]
		int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);

		[PreserveSig]
		int GetBufferSize(out uint bufferFrameCount);

		[PreserveSig]
		int GetStreamLatency(out long latency);

		[PreserveSig]
		int GetCurrentPadding(out uint padding);

		[PreserveSig]
		int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

		[PreserveSig]
		int GetMixFormat(out IntPtr format);

		[PreserveSig]
		int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

		[PreserveSig]
		int Start();

		[PreserveSig]
		int Stop();

		[PreserveSig]
		int Reset();

		[PreserveSig]
		int SetEventHandle(IntPtr handle);

		[PreserveSig]
		int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
	}

	[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAudioCaptureClient
	{
		[PreserveSig]
		int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out long devicePosition, out long qpcPosition);

		[PreserveSig]
		int ReleaseBuffer(uint numFramesRead);

		[PreserveSig]
		int GetNextPacketSize(out uint numFramesInNextPacket);
	}

	[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IActivateAudioInterfaceCompletionHandler
	{
		void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
	}

	// Marker interface, no methods of its own.
	[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IAgileObject
	{
	}

	[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	internal interface IActivateAudioInterfaceAsyncOperation
	{
		[PreserveSig]
		int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
	}
}
