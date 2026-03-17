/**
 * Discord slash-command server for playback control.
 *
 * Runs a lightweight discord.js bot alongside the user-token stream to
 * handle `/skip-forward`, `/skip-backward`, `/seek`, and `/playtime`.
 *
 * Key improvement over the alt-branch implementation:
 *  - Seek/skip uses the in-process PlaybackStateManager restart emitter
 *    instead of spawning background sub-processes and `killall -9`.
 *  - No shell commands, no hardcoded paths, no process-level side effects.
 */

import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { PlaybackStateManager } from './PlaybackState.js';
import type { Logger } from '../utils/logger.js';

export interface CommandServerOptions {
  botToken: string;
  guildId: string;
  logger: Logger;
  playbackState: PlaybackStateManager;
}

export class CommandServer {
  private client: Client | undefined;
  private readonly logger: Logger;
  private readonly state: PlaybackStateManager;
  private readonly botToken: string;
  private readonly guildId: string;

  constructor(opts: CommandServerOptions) {
    this.logger = opts.logger.child('CommandServer');
    this.state = opts.playbackState;
    this.botToken = opts.botToken;
    this.guildId = opts.guildId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client.once('ready', async () => {
      this.logger.info('Command bot connected', {
        username: this.client?.user?.tag,
      });
      if (this.client?.user) {
        await this.registerCommands(this.client.user.id);
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await this.handleCommand(interaction);
      } catch (err) {
        this.logger.error('Interaction handler error', {
          message: err instanceof Error ? err.message : String(err),
        });
        if (!interaction.replied && !interaction.deferred) {
          await interaction
            .reply({ content: 'An error occurred.', ephemeral: true })
            .catch(() => {});
        }
      }
    });

    await this.client.login(this.botToken);
    this.logger.info('CommandServer started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
      this.logger.info('CommandServer stopped');
    }
  }

  // ── Command registration ───────────────────────────────────────────

  private async registerCommands(clientId: string): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('skip-forward')
        .setDescription('Skip forward by N seconds')
        .addIntegerOption((o) =>
          o.setName('seconds').setDescription('Seconds to skip').setRequired(true).setMinValue(1),
        ),
      new SlashCommandBuilder()
        .setName('skip-backward')
        .setDescription('Skip backward by N seconds')
        .addIntegerOption((o) =>
          o.setName('seconds').setDescription('Seconds to skip').setRequired(true).setMinValue(1),
        ),
      new SlashCommandBuilder()
        .setName('seek')
        .setDescription('Seek to a specific timestamp (MM:SS or HH:MM:SS)')
        .addStringOption((o) =>
          o.setName('time').setDescription('Timestamp (MM:SS or HH:MM:SS)').setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('playtime')
        .setDescription('Show current playback position and duration'),
      new SlashCommandBuilder()
        .setName('next-episode')
        .setDescription('Skip to the next episode (series auto-play)'),
    ];

    const rest = new REST({ version: '10' }).setToken(this.botToken);
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, this.guildId), {
        body: commands.map((c) => c.toJSON()),
      });
      this.logger.info('Slash commands registered', { guildId: this.guildId });
    } catch (err) {
      this.logger.error('Failed to register slash commands', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Command handling ───────────────────────────────────────────────

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (!guildId || !channelId) {
      await interaction.reply({ content: 'Could not determine guild or channel.', ephemeral: true });
      return;
    }

    const session = this.state.getSession(guildId, channelId);
    if (!session) {
      await interaction.reply({ content: 'No active stream in this channel.', ephemeral: true });
      return;
    }

    switch (interaction.commandName) {
      case 'playtime':
        await this.handlePlaytime(interaction, guildId, channelId, session.duration);
        break;
      case 'skip-forward':
        await this.handleSkip(interaction, guildId, channelId, session.duration, 1);
        break;
      case 'skip-backward':
        await this.handleSkip(interaction, guildId, channelId, session.duration, -1);
        break;
      case 'seek':
        await this.handleSeek(interaction, guildId, channelId, session.duration);
        break;
      case 'next-episode':
        await this.handleNextEpisode(interaction, guildId, channelId);
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  }

  private async handlePlaytime(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    channelId: string,
    duration: number,
  ): Promise<void> {
    const pos = this.state.getPosition(guildId, channelId);
    const posStr = PlaybackStateManager.formatTime(pos);
    const durStr = PlaybackStateManager.formatTime(duration);
    const pct = duration > 0 ? Math.round((pos / duration) * 100) : 0;
    const remaining = Math.max(0, duration - pos);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Playback Status')
      .setDescription(`**${posStr}** / **${durStr}**`)
      .setFields(
        { name: 'Progress', value: `${pct}%`, inline: true },
        { name: 'Remaining', value: PlaybackStateManager.formatTime(remaining), inline: true },
      );

    await interaction.reply({ embeds: [embed] });
  }

  private async handleSkip(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    channelId: string,
    duration: number,
    direction: 1 | -1,
  ): Promise<void> {
    const seconds = interaction.options.getInteger('seconds', true);
    const current = this.state.getPosition(guildId, channelId);
    const target = Math.max(0, Math.min(current + seconds * direction, duration));

    const ok = this.state.requestRestart(guildId, channelId, target);
    if (!ok) {
      await interaction.reply({ content: 'No active stream to skip.', ephemeral: true });
      return;
    }

    const label = direction > 0 ? 'Skipped forward' : 'Skipped backward';
    await interaction.reply(
      `${label} to **${PlaybackStateManager.formatTime(target)}** / **${PlaybackStateManager.formatTime(duration)}**`,
    );
  }

  private async handleSeek(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    channelId: string,
    duration: number,
  ): Promise<void> {
    const timeStr = interaction.options.getString('time', true);
    const parsed = PlaybackStateManager.parseTime(timeStr);

    if (parsed === null || (duration > 0 && parsed > duration)) {
      const maxStr = duration > 0 ? ` (max: ${PlaybackStateManager.formatTime(duration)})` : '';
      await interaction.reply({
        content: `Invalid time. Use MM:SS or HH:MM:SS${maxStr}`,
        ephemeral: true,
      });
      return;
    }

    const ok = this.state.requestRestart(guildId, channelId, parsed);
    if (!ok) {
      await interaction.reply({ content: 'No active stream to seek.', ephemeral: true });
      return;
    }

    await interaction.reply(
      `Seeking to **${PlaybackStateManager.formatTime(parsed)}** / **${PlaybackStateManager.formatTime(duration)}**`,
    );
  }

  private async handleNextEpisode(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    channelId: string,
  ): Promise<void> {
    const session = this.state.getSession(guildId, channelId);
    if (!session) {
      await interaction.reply({ content: 'No active stream.', ephemeral: true });
      return;
    }

    // Seek to beyond the duration to trigger natural stream end,
    // which the auto-play loop in play-search will pick up.
    const target = session.duration > 0 ? session.duration : 999_999;
    const ok = this.state.requestRestart(guildId, channelId, target);
    if (!ok) {
      await interaction.reply({ content: 'No active stream to skip.', ephemeral: true });
      return;
    }

    await interaction.reply('Skipping to next episode...');
  }
}
