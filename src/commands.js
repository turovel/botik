import { ChannelType, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Add a YouTube video to the music queue.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube link or search text.')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search YouTube and pick a result to queue.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube search text.')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Add every video from a YouTube playlist to the queue.')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('YouTube playlist link, or a YouTube link that contains list=...')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue.'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the current track.'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track.'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause playback.'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume playback.'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave voice.'),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Connect the bot to a voice channel.')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to join. Defaults to your current channel.')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect the bot from voice and clear the queue.'),
];
