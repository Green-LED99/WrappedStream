/**
 * Playback state manager — tracks the current seek position, duration,
 * and restart requests for each active stream session keyed by
 * guild:channel.
 *
 * Improvement over alt-branch: no mutable global singleton export.
 * Instead, callers create an instance and pass it where needed.
 */

import { EventEmitter } from 'node:events';

export interface PlaybackSession {
  guildId: string;
  channelId: string;
  videoUrl: string;
  /** Wall-clock time (ms) when playback started at `seekSeconds`. */
  startedAt: number;
  /** Total media duration in seconds (0 when unknown). */
  duration: number;
  /** The seek offset that corresponds to `startedAt`. */
  seekSeconds: number;
  /** Emits `'restart'` with the new seek position in seconds. */
  restartEmitter: EventEmitter;
}

export class PlaybackStateManager {
  private readonly sessions = new Map<string, PlaybackSession>();

  private static key(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  // ── Session lifecycle ──────────────────────────────────────────────

  startSession(
    guildId: string,
    channelId: string,
    videoUrl: string,
    duration: number,
    seekSeconds = 0,
  ): PlaybackSession {
    const key = PlaybackStateManager.key(guildId, channelId);
    const existing = this.sessions.get(key);

    // Re-use the restart emitter across seeks so listeners survive restarts.
    const restartEmitter = existing?.restartEmitter ?? new EventEmitter();

    const session: PlaybackSession = {
      guildId,
      channelId,
      videoUrl,
      startedAt: Date.now(),
      duration,
      seekSeconds,
      restartEmitter,
    };
    this.sessions.set(key, session);
    return session;
  }

  endSession(guildId: string, channelId: string): void {
    const key = PlaybackStateManager.key(guildId, channelId);
    const session = this.sessions.get(key);
    if (session) {
      session.restartEmitter.removeAllListeners();
      this.sessions.delete(key);
    }
  }

  // ── Queries ────────────────────────────────────────────────────────

  getSession(guildId: string, channelId: string): PlaybackSession | undefined {
    return this.sessions.get(PlaybackStateManager.key(guildId, channelId));
  }

  /**
   * Estimated playback position in seconds, clamped to [0, duration].
   */
  getPosition(guildId: string, channelId: string): number {
    const s = this.getSession(guildId, channelId);
    if (!s) return 0;
    const elapsed = (Date.now() - s.startedAt) / 1_000;
    const pos = s.seekSeconds + elapsed;
    return s.duration > 0 ? Math.min(pos, s.duration) : pos;
  }

  // ── Restart request ────────────────────────────────────────────────

  /**
   * Signal the stream loop to restart FFmpeg at `seekSeconds`.
   * The restart emitter fires `'restart'` which the stream loop listens for.
   */
  requestRestart(guildId: string, channelId: string, seekSeconds: number): boolean {
    const s = this.getSession(guildId, channelId);
    if (!s) return false;
    s.restartEmitter.emit('restart', seekSeconds);
    return true;
  }

  // ── Formatting helpers ─────────────────────────────────────────────

  static formatTime(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3_600);
    const m = Math.floor((totalSeconds % 3_600) / 60);
    const s = Math.floor(totalSeconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Parse `MM:SS` or `HH:MM:SS` into seconds.  Returns `null` on invalid input.
   */
  static parseTime(input: string): number | null {
    const parts = input.split(':').map(Number);
    if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;

    if (parts.length === 2) {
      const [minutes, seconds] = parts as [number, number];
      if (seconds >= 60) return null;
      return minutes * 60 + seconds;
    }
    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts as [number, number, number];
      if (minutes >= 60 || seconds >= 60) return null;
      return hours * 3_600 + minutes * 60 + seconds;
    }
    return null;
  }
}
