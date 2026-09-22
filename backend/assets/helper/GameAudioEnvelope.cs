/* Game audio envelope helper for the Steam Music Player plugin.
 *
 * Measures how loud the running game currently is and reports how far the
 * music should be ducked, so the player can behave like a music bus inside the
 * game's mix instead of an app playing over the top of it.
 *
 * ---------------------------------------------------------------------------
 * Why a separate process at all
 *
 * The player's audio lives in Steam's CEF, and a browser context cannot see
 * what other applications are playing. Windows can, through WASAPI, but only
 * from native code.
 *
 * ---------------------------------------------------------------------------
 * Targeting: the running Steam game only. Discord and every other app
 * are ignored, even if they are louder. The music ducks under the game
 * and nothing else.
 *
 * Why the game is included rather than Steam excluded
 *
 * Process loopback capture (Windows 10 build 20348 and later) can capture a
 * process tree, or everything except a process tree. The obvious approach is to
 * capture everything except Steam, since that would exclude the player's own
 * output and need no knowledge of which game is running. It is also wrong:
 * Steam launches games as its own children, so excluding Steam's process tree
 * would exclude the game as well - exactly the signal being measured.
 *
 * So the game is targeted explicitly instead. Audio sessions on the default
 * render device are enumerated, Steam and Discord are discarded by name, and
 * only a process whose executable lives under steamapps\\common is captured
 * with INCLUDE_TARGET_PROCESS_TREE. If no game is making sound, the reported
 * duck is zero and the music plays as mastered.
 *
 * ---------------------------------------------------------------------------
 * What gets measured
 *
 * Captured audio is K-weighted and accumulated into short blocks per ITU-R
 * BS.1770, the same measurement broadcast and game audio are specified in, so
 * the level that comes out is perceptual rather than a raw peak - a bass rumble
 * and a dialogue line at the same meter reading duck the music by a comparable
 * amount, which a peak meter would get wrong.
 *
 * Attack and release smoothing happens here, at audio rate, rather than in the
 * player. The player samples this file at around 25 Hz, and an envelope
 * followed at that rate would be too coarse to catch a transient. What crosses
 * the process boundary is a settled figure the player only has to glide to.
 *
 * ---------------------------------------------------------------------------
 * Build: scripts/build-helper.ps1 (uses the in-box .NET Framework compiler, so
 * nothing needs installing). C# 5 only - no interpolated strings, no null
 * conditional operators.
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace SteamMusicPlayer
{
	internal static class Program
	{
		// Processes whose audio must never be treated as game audio. The player
		// itself renders through steamwebhelper (Chromium's audio service runs
		// as one of its children), so including it would make the music duck
		// against itself.
		private static readonly string[] SteamFamily = new string[]
		{
			"steam",
			"steamwebhelper",
			"steamservice",
			"steamerrorreporter",
			"steamerrorreporter64",
			"gameoverlayui",
			"streaming_client",
			"gameaudioenvelope",
			"discord",
			"discordptb",
			"discordcanary",
			"discorddevelopment",
		};

		// Ducking response. Threshold is short-term loudness of the game, in
		// LUFS, at which the music starts giving way. Games are mixed to about
		// -24 LUFS on average, so a threshold slightly below that leaves quiet
		// moments untouched while anything above conversational level starts to
		// take priority. Ratio follows the 4:1 that game mixers commonly use
		// for music-under-dialogue ducking.
		private const double DuckThresholdLufs = -28.0;
		private const double DuckRatio = 3.5;
		private const double DuckKneeDb = 8.0;

		// Deepest attenuation reported. The player clamps this again to its own
		// per-listening-setup profile; this is only a sanity bound.
		private const double MaxDuckDb = -18.0;

		// Fast down, hold, then slow up. A hold keeps a gunshot from letting
		// the music flutter back up in the gap before the next one; matching
		// attack and release is what makes ducking pump.
		private const double AttackSeconds = 0.02;
		private const double HoldSeconds = 0.18;
		private const double ReleaseSeconds = 0.85;

		private const double BlockSeconds = 0.02;
		private const int OutputIntervalMs = 25;

		// Below this the block is treated as silence rather than measured, which
		// keeps denormal-level noise from holding a duck open.
		private const double SilenceFloorLufs = -70.0;

		private static string _outputPath;
		private static string _stopFlagPath;
		private static string _logPath;
		private static string _steamPath;
		private static GameIdentifier _games;
		private static long _sequence;

		// Checking whether Steam is still running means enumerating every
		// process on the machine, which took hundreds of milliseconds and, done
		// once per loop iteration, starved the capture loop it was guarding.
		private const int StopCheckIntervalMs = 500;
		private static readonly Stopwatch _sinceStopCheck = Stopwatch.StartNew();
		private static bool _lastStopResult;

		private static void Log(string message)
		{
			if (_logPath == null)
			{
				return;
			}
			try
			{
				// Truncate rather than grow without bound; this is a diagnostic
				// of the current session, not a history.
				if (new FileInfo(_logPath).Exists && new FileInfo(_logPath).Length > 256 * 1024)
				{
					File.Delete(_logPath);
				}
				File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine);
			}
			catch
			{
				/* diagnostics must never take the helper down */
			}
		}

		private static int Main(string[] args)
		{
			if (args.Length < 2)
			{
				Console.Error.WriteLine("usage: GameAudioEnvelope.exe <outputFile> <stopFlagFile>");
				return 1;
			}

			_outputPath = args[0];
			_stopFlagPath = args[1];
			_logPath = args.Length > 2 ? args[2] : _outputPath + ".log";
			_steamPath = args.Length > 3 ? args[3] : null;

			/* Single instance, enforced here rather than by the caller.
			 *
			 * Millennium can reload the plugin without Steam restarting, and the
			 * Lua side has no process handle to check - it would happily launch a
			 * second helper while the first was still running, leaving two
			 * processes interleaving writes into the same envelope file. Holding
			 * a named mutex means a duplicate launch simply exits and the
			 * original keeps serving. */
			bool createdNew;
			using (Mutex instanceLock = new Mutex(true, "Local\\SteamMusicPlayer.GameAudioEnvelope", out createdNew))
			{
				if (!createdNew)
				{
					Log("another helper instance is already running, exiting");
					return 0;
				}

				Log("helper starting, output=" + _outputPath);

				_games = new GameIdentifier(_steamPath);
				foreach (string root in _games.Roots)
				{
					Log("game library root: " + root);
				}

				return RunOnWorkerThread();
			}
		}

		private static int RunOnWorkerThread()
		{
			// ActivateAudioInterfaceAsync completes on a worker thread, so this
			// thread must not be an STA that would need a message pump to
			// receive it.
			Thread worker = new Thread(RunLoop, 512 * 1024);
			worker.SetApartmentState(ApartmentState.MTA);
			worker.IsBackground = false;
			worker.Start();
			worker.Join();
			return 0;
		}

		private static bool ShouldStop()
		{
			if (_lastStopResult)
			{
				return true;
			}
			if (_sinceStopCheck.ElapsedMilliseconds < StopCheckIntervalMs)
			{
				return false;
			}
			_sinceStopCheck.Restart();

			try
			{
				if (File.Exists(_stopFlagPath))
				{
					Log("stop flag seen, exiting");
					_lastStopResult = true;
					return true;
				}
			}
			catch
			{
				/* treat an unreadable flag as "keep going" */
			}

			// If Steam is gone there is nothing left to serve, and without this
			// the helper would outlive a Steam crash.
			try
			{
				if (Process.GetProcessesByName("steam").Length == 0)
				{
					Log("steam is gone, exiting");
					_lastStopResult = true;
					return true;
				}
			}
			catch
			{
				/* enumeration failure is not a reason to exit */
			}
			return false;
		}

		private static void RunLoop()
		{
			WriteEnvelope(0, SilenceFloorLufs, 0);

			while (!ShouldStop())
			{
				int targetPid = 0;
				bool targetIsGame = false;
				try
				{
					SessionScan scan = AudioSessions.Scan(SteamFamily, 0, _games);
					targetPid = scan.BestPid;
					targetIsGame = scan.BestIsGame;
				}
				catch (Exception e)
				{
					Log("session scan failed: " + e.Message);
				}

				if (targetPid == 0)
				{
					// No game is making noise, so there is nothing to duck under
					// and the music plays as mastered.
					WriteEnvelope(0, SilenceFloorLufs, 0);
					Sleep(400);
					continue;
				}

				try
				{
					if (!targetIsGame)
					{
						WriteEnvelope(0, SilenceFloorLufs, 0);
						Sleep(400);
						continue;
					}
					Log("targeting game pid " + targetPid + " (" + SafeProcessName(targetPid) + ")");
					CaptureFrom(targetPid);
					Log("capture of pid " + targetPid + " ended");
				}
				catch (Exception e)
				{
					Log("capture failed for pid " + targetPid + ": " + e.GetType().Name + ": " + e.Message);
					WriteEnvelope(0, SilenceFloorLufs, targetPid);
					Sleep(500);
				}
			}

			WriteEnvelope(0, SilenceFloorLufs, 0);
		}

		private static void Sleep(int ms)
		{
			// Broken into slices so a stop request is noticed promptly.
			int waited = 0;
			while (waited < ms)
			{
				if (ShouldStop())
				{
					return;
				}
				Thread.Sleep(Math.Min(100, ms - waited));
				waited += 100;
			}
		}

		/* Captures the given process tree until it stops being the right thing
		 * to listen to, then returns so the caller can re-target. */
		private static void CaptureFrom(int processId)
		{
			LoopbackCapture capture = new LoopbackCapture();
			try
			{
				capture.Start(processId);

				int channels = capture.Channels;
				int sampleRate = capture.SampleRate;
				Log("capture started: " + sampleRate + " Hz, " + channels + " ch");
				Stopwatch sinceHealthLog = Stopwatch.StartNew();
				long framesSeen = 0;
				LoudnessMeter meter = new LoudnessMeter(sampleRate, channels, BlockSeconds);
				EnvelopeFollower envelope = new EnvelopeFollower(BlockSeconds, AttackSeconds, HoldSeconds, ReleaseSeconds, SilenceFloorLufs);

				Stopwatch sinceOutput = Stopwatch.StartNew();
				Stopwatch sinceAudio = Stopwatch.StartNew();
				Stopwatch sinceRetarget = Stopwatch.StartNew();
				Stopwatch sinceSilenceFill = Stopwatch.StartNew();

				while (!ShouldStop())
				{
					bool gotAudio = capture.Pump(meter);

					double blockLoudness;
					while (meter.TryTakeBlock(out blockLoudness))
					{
						envelope.Push(blockLoudness);
					}

					if (gotAudio)
					{
						sinceAudio.Restart();
						sinceSilenceFill.Restart();
					}
					else
					{
						// A silent process delivers no buffers at all rather than
						// buffers of zeroes, so the envelope would freeze at its
						// last value - holding the music down after the game went
						// quiet. Feeding it the silence it did not send, in real
						// time, is what lets the duck release.
						int blocksOwed = (int)(sinceSilenceFill.Elapsed.TotalSeconds / BlockSeconds);
						for (int i = 0; i < blocksOwed; i++)
						{
							envelope.Push(SilenceFloorLufs);
						}
						if (blocksOwed > 0)
						{
							sinceSilenceFill.Restart();
						}
					}

					framesSeen += capture.LastFrameCount;

					if (sinceOutput.ElapsedMilliseconds >= OutputIntervalMs)
					{
						sinceOutput.Restart();
						WriteEnvelope(DuckDbFor(envelope.Value), envelope.Value, processId);
					}

					if (sinceHealthLog.ElapsedMilliseconds >= 2000)
					{
						sinceHealthLog.Restart();
						Log("pid " + processId + ": " + framesSeen + " frames in the last 2s, loudness "
							+ envelope.Value.ToString("0.0") + " LUFS, duck " + DuckDbFor(envelope.Value).ToString("0.00") + " dB");
						framesSeen = 0;
					}

					/* Stay on this game until it exits or another game is
					 * clearly louder. Quiet stretches are when the music should
					 * come back up, not when we go looking for Discord. */
					if (sinceRetarget.ElapsedMilliseconds > 3000)
					{
						sinceRetarget.Restart();
						if (!IsProcessAlive(processId))
						{
							Log("target pid " + processId + " exited");
							return;
						}

						try
						{
							SessionScan scan = AudioSessions.Scan(SteamFamily, processId, _games);
							if (scan.BestPid == 0 || !scan.BestIsGame)
							{
								Log("no game audio source any more, releasing pid " + processId);
								return;
							}
							if (scan.BestPid != processId && scan.BestIsGame && scan.BestPeak > scan.CurrentPeak * 2.5f)
							{
								Log("switching from game pid " + processId + " to game pid " + scan.BestPid
									+ " (" + SafeProcessName(scan.BestPid) + ")");
								return;
							}
						}
						catch (Exception e)
						{
							Log("retarget scan failed: " + e.Message);
						}
					}
				}
			}
			finally
			{
				capture.Dispose();
			}
		}

		private static string SafeProcessName(int pid)
		{
			try
			{
				return Process.GetProcessById(pid).ProcessName;
			}
			catch
			{
				return "unknown";
			}
		}

		private static bool IsProcessAlive(int pid)
		{
			try
			{
				Process p = Process.GetProcessById(pid);
				return !p.HasExited;
			}
			catch
			{
				return false;
			}
		}

		/* Loudness above the threshold is reduced by the ratio, in the same way
		 * a compressor's static curve works, and reported as negative dB. A
		 * soft knee starts the duck a few LU early so the music eases out of
		 * the way instead of slamming down the moment dialogue crosses -28. */
		private static double DuckDbFor(double loudnessLufs)
		{
			if (double.IsNaN(loudnessLufs) || double.IsInfinity(loudnessLufs))
			{
				return 0;
			}
			double over = loudnessLufs - DuckThresholdLufs;
			double halfKnee = DuckKneeDb / 2.0;
			if (over <= -halfKnee)
			{
				return 0;
			}
			double effectiveOver = over < halfKnee
				? (over + halfKnee) * (over + halfKnee) / (2.0 * DuckKneeDb)
				: over;
			double reduction = -effectiveOver * (1.0 - 1.0 / DuckRatio);
			return reduction < MaxDuckDb ? MaxDuckDb : reduction;
		}

		/* One fixed-shape line, rewritten in place, ending in a sentinel.
		 *
		 * The reader polls this file far more often than it changes and does no
		 * locking, so it can catch a write half-finished. Requiring the trailing
		 * '#' makes a torn read detectable rather than silently parsed as a
		 * wrong duck value, and the sequence number lets the reader notice that
		 * the helper has stopped updating at all. */
		private static void WriteEnvelope(double duckDb, double gameLufs, int pid)
		{
			_sequence++;
			string line = string.Format(
				CultureInfo.InvariantCulture,
				"SMPDUCK|{0}|{1:0.00}|{2:0.0}|{3}|#",
				_sequence,
				duckDb,
				double.IsInfinity(gameLufs) || double.IsNaN(gameLufs) ? SilenceFloorLufs : gameLufs,
				pid);

			try
			{
				using (FileStream stream = new FileStream(_outputPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
				using (StreamWriter writer = new StreamWriter(stream))
				{
					writer.Write(line);
				}
			}
			catch
			{
				/* A failed write just means the reader keeps the previous value
				 * and, if it persists, sees the sequence stall. */
			}
		}
	}

	/* Integrated-style loudness over short blocks, per ITU-R BS.1770: K-weight
	 * each channel, sum the mean square across channels (summed, not averaged -
	 * which is why the same signal on two channels reads 3 LU louder than on
	 * one), then convert with the spec's -0.691 dB offset.
	 *
	 * The gating the full standard applies is deliberately left out. Gating
	 * exists to stop silence from dragging down the average of a whole
	 * programme; here each block is wanted on its own, precisely so quiet
	 * moments read as quiet and the music comes back up. */
	internal sealed class LoudnessMeter
	{
		private readonly int _channels;
		private readonly int _blockFrames;
		private readonly KWeightingFilter[] _filters;
		private readonly Queue<double> _blocks = new Queue<double>();

		private double _sumOfSquares;
		private int _framesAccumulated;

		public LoudnessMeter(int sampleRate, int channels, double blockSeconds)
		{
			_channels = channels;
			_blockFrames = Math.Max(1, (int)(sampleRate * blockSeconds));
			_filters = new KWeightingFilter[channels];
			for (int i = 0; i < channels; i++)
			{
				_filters[i] = new KWeightingFilter(sampleRate);
			}
		}

		// Interleaved frames, one float per sample, already converted to -1..1.
		public void AddSamples(float[] interleaved, int frameCount)
		{
			for (int frame = 0; frame < frameCount; frame++)
			{
				int baseIndex = frame * _channels;
				for (int ch = 0; ch < _channels; ch++)
				{
					double weighted = _filters[ch].Process(interleaved[baseIndex + ch]);
					_sumOfSquares += weighted * weighted;
				}

				_framesAccumulated++;
				if (_framesAccumulated >= _blockFrames)
				{
					double meanSquare = _sumOfSquares / _framesAccumulated;
					_blocks.Enqueue(meanSquare > 0 ? -0.691 + 10.0 * Math.Log10(meanSquare) : double.NegativeInfinity);
					_sumOfSquares = 0;
					_framesAccumulated = 0;
				}
			}
		}

		public bool TryTakeBlock(out double loudness)
		{
			if (_blocks.Count == 0)
			{
				loudness = 0;
				return false;
			}
			loudness = _blocks.Dequeue();
			return true;
		}
	}

	/* The BS.1770 pre-filter: a +4 dB high shelf followed by a high-pass.
	 *
	 * The spec tabulates coefficients for 48 kHz only, and the capture rate here
	 * is whatever the shared mixer is running at, so they are derived for the
	 * actual rate with the standard Audio EQ Cookbook formulas rather than
	 * assuming 48 kHz. */
	internal sealed class KWeightingFilter
	{
		private readonly Biquad _shelf;
		private readonly Biquad _highpass;

		public KWeightingFilter(int sampleRate)
		{
			_shelf = Biquad.HighShelf(sampleRate, 1681.97, 0.7071067811865476, 3.99984);
			_highpass = Biquad.HighPass(sampleRate, 38.135, 0.5);
		}

		public double Process(double sample)
		{
			return _highpass.Process(_shelf.Process(sample));
		}
	}

	internal sealed class Biquad
	{
		private readonly double _b0, _b1, _b2, _a1, _a2;
		private double _x1, _x2, _y1, _y2;

		private Biquad(double b0, double b1, double b2, double a0, double a1, double a2)
		{
			_b0 = b0 / a0;
			_b1 = b1 / a0;
			_b2 = b2 / a0;
			_a1 = a1 / a0;
			_a2 = a2 / a0;
		}

		public static Biquad HighShelf(int sampleRate, double freq, double q, double gainDb)
		{
			double a = Math.Pow(10, gainDb / 40);
			double w0 = 2 * Math.PI * freq / sampleRate;
			double cos0 = Math.Cos(w0);
			double alpha = Math.Sin(w0) / (2 * q);
			double t = 2 * Math.Sqrt(a) * alpha;

			return new Biquad(
				a * ((a + 1) + (a - 1) * cos0 + t),
				-2 * a * ((a - 1) + (a + 1) * cos0),
				a * ((a + 1) + (a - 1) * cos0 - t),
				(a + 1) - (a - 1) * cos0 + t,
				2 * ((a - 1) - (a + 1) * cos0),
				(a + 1) - (a - 1) * cos0 - t);
		}

		public static Biquad HighPass(int sampleRate, double freq, double q)
		{
			double w0 = 2 * Math.PI * freq / sampleRate;
			double cos0 = Math.Cos(w0);
			double alpha = Math.Sin(w0) / (2 * q);

			return new Biquad(
				(1 + cos0) / 2,
				-(1 + cos0),
				(1 + cos0) / 2,
				1 + alpha,
				-2 * cos0,
				1 - alpha);
		}

		public double Process(double x0)
		{
			double y0 = _b0 * x0 + _b1 * _x1 + _b2 * _x2 - _a1 * _y1 - _a2 * _y2;
			_x2 = _x1;
			_x1 = x0;
			_y2 = _y1;
			_y1 = y0;
			return y0;
		}
	}

	/* One-pole smoothing with separate rise and fall constants, plus a hold
	 * so a brief quiet gap does not start the release. Working in dB because
	 * that is the domain the duck is specified in. */
	internal sealed class EnvelopeFollower
	{
		private readonly double _attackCoefficient;
		private readonly double _releaseCoefficient;
		private readonly double _holdSeconds;
		private readonly double _blockSeconds;
		private readonly double _floor;
		private double _holdRemaining;

		public double Value { get; private set; }

		public EnvelopeFollower(double blockSeconds, double attackSeconds, double holdSeconds, double releaseSeconds, double floor)
		{
			_attackCoefficient = 1.0 - Math.Exp(-blockSeconds / attackSeconds);
			_releaseCoefficient = 1.0 - Math.Exp(-blockSeconds / releaseSeconds);
			_holdSeconds = holdSeconds;
			_blockSeconds = blockSeconds;
			_floor = floor;
			Value = floor;
		}

		public void Push(double loudness)
		{
			if (double.IsNaN(loudness) || double.IsInfinity(loudness) || loudness < _floor)
			{
				loudness = _floor;
			}
			if (loudness > Value)
			{
				// Rising loudness means the duck is deepening, so that is the
				// fast direction. A new peak also restarts the hold.
				Value += (loudness - Value) * _attackCoefficient;
				_holdRemaining = _holdSeconds;
				return;
			}
			if (_holdRemaining > 0)
			{
				_holdRemaining -= _blockSeconds;
				return;
			}
			Value += (loudness - Value) * _releaseCoefficient;
		}
	}
}
