import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { Innertube } from 'youtubei.js';
import { ChannelType } from 'discord.js';
import { spawn } from 'node:child_process';
import youtubedl from 'youtube-dl-exec';

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

if (!ffmpegPath) {
  throw new Error('ffmpeg-static did not provide an ffmpeg binary path.');
}

const IDLE_LEAVE_MS = 120_000;
const MAX_QUEUE_DISPLAY = 10;
const SEARCH_CANDIDATES_TO_VALIDATE = 5;
const YT_DLP_METADATA_TIMEOUT_MS = 45_000;
const YT_DLP_PLAYLIST_TIMEOUT_MS = 120_000;
let youtubeClientPromise;

export class MusicManager {
  constructor(client) {
    this.client = client;
    this.queues = new Map();
  }

  async enqueue(interaction, query) {
    const voiceChannel = await this.getTargetVoiceChannel(interaction);
    assertVoiceChannel(voiceChannel);
    const tracks = await resolveTracks(query, interaction.user);
    return this.enqueueTracks(interaction, tracks, voiceChannel);
  }

  async enqueueVideoId(interaction, videoId, fallback = {}) {
    const voiceChannel = await this.getTargetVoiceChannel(interaction);
    assertVoiceChannel(voiceChannel);
    const track = await createTrackFromVideoId(videoId, interaction.user, fallback);
    return this.enqueueTracks(interaction, [track], voiceChannel);
  }

  async search(query, limit = MAX_QUEUE_DISPLAY) {
    return searchYoutubeVideos(query, limit);
  }

  async enqueueTracks(interaction, tracks, voiceChannel) {
    if (tracks.length === 0) {
      throw new UserFacingError('Не нашел треки для добавления в очередь.');
    }

    const queue = this.getOrCreateQueue(interaction.guild, interaction.channel);

    await this.connect(queue, voiceChannel);

    const firstTrack = tracks[0];
    const startPosition = queue.tracks.length + 1;
    const shouldStartNow = queue.player.state.status === AudioPlayerStatus.Idle && !queue.current;

    queue.tracks.push(...tracks);

    if (shouldStartNow) {
      this.playNext(queue.guildId);

      if (tracks.length === 1) {
        return `Запускаю: ${formatTrack(firstTrack)}`;
      }

      return `Добавил ${tracks.length} треков из плейлиста. Запускаю: ${formatTrack(firstTrack)}`;
    }

    if (tracks.length === 1) {
      return `Добавил в очередь: ${formatTrack(firstTrack)}. Позиция: ${startPosition}.`;
    }

    return `Добавил ${tracks.length} треков из плейлиста в очередь. Позиции: ${startPosition}-${startPosition + tracks.length - 1}.`;
  }

  async join(interaction, requestedChannel) {
    const voiceChannel = requestedChannel ?? (await this.getTargetVoiceChannel(interaction));

    if (!voiceChannel) {
      throw new UserFacingError(
        'Не вижу войс-канал. Зайди в голосовой канал или передай channel в /join.',
      );
    }

    const queue = this.getOrCreateQueue(interaction.guild, interaction.channel);
    await this.connect(queue, voiceChannel);

    return `Подключился к ${voiceChannel.name}.`;
  }

  skip(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue?.current) {
      throw new UserFacingError('Сейчас ничего не играет.');
    }

    queue.player.stop(true);
    return `Скипаю: ${formatTrack(queue.current)}.`;
  }

  pause(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue?.current) {
      throw new UserFacingError('Сейчас ничего не играет.');
    }

    if (!queue.player.pause()) {
      throw new UserFacingError('Не получилось поставить на паузу.');
    }

    return 'Пауза.';
  }

  resume(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue?.current) {
      throw new UserFacingError('Сейчас ничего не играет.');
    }

    if (!queue.player.unpause()) {
      throw new UserFacingError('Не получилось продолжить воспроизведение.');
    }

    return `Продолжаю: ${formatTrack(queue.current)}.`;
  }

  stop(guildId) {
    const queue = this.queues.get(guildId);
    const connection = getVoiceConnection(guildId);

    if (!queue && !connection) {
      throw new UserFacingError('Бот сейчас не подключен.');
    }

    if (queue) {
      queue.tracks = [];
      queue.current = null;
      queue.stopped = true;
      clearTimeout(queue.idleTimer);
      queue.player.stop(true);
      this.queues.delete(guildId);
    }

    connection?.destroy();
    return 'Остановил музыку, очистил очередь и вышел из войса.';
  }

  queue(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue || (!queue.current && queue.tracks.length === 0)) {
      return 'Очередь пустая.';
    }

    const lines = [];

    if (queue.current) {
      lines.push(`Сейчас играет: ${formatTrack(queue.current)}`);
    }

    if (queue.tracks.length > 0) {
      const shown = queue.tracks
        .slice(0, MAX_QUEUE_DISPLAY)
        .map((track, index) => `${index + 1}. ${formatTrack(track)}`);

      lines.push('Дальше:', ...shown);

      if (queue.tracks.length > MAX_QUEUE_DISPLAY) {
        lines.push(`...и еще ${queue.tracks.length - MAX_QUEUE_DISPLAY}.`);
      }
    }

    return lines.join('\n');
  }

  nowPlaying(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue?.current) {
      return 'Сейчас ничего не играет.';
    }

    return `Сейчас играет: ${formatTrack(queue.current)}`;
  }

  getOrCreateQueue(guild, textChannel) {
    const existing = this.queues.get(guild.id);

    if (existing) {
      existing.textChannelId = textChannel?.id ?? existing.textChannelId;
      existing.stopped = false;
      return existing;
    }

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    const queue = {
      guildId: guild.id,
      guildName: guild.name,
      textChannelId: textChannel?.id,
      connection: null,
      player,
      tracks: [],
      current: null,
      idleTimer: null,
      stopped: false,
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (!queue.stopped) {
        this.playNext(queue.guildId);
      }
    });

    player.on('error', (error) => {
      const title = queue.current?.title ?? 'трек';
      console.error(`Audio player error in ${queue.guildName}:`, error);
      this.sendQueueMessage(queue, `Ошибка воспроизведения "${title}", пробую следующий трек.`);
      this.playNext(queue.guildId);
    });

    this.queues.set(guild.id, queue);
    return queue;
  }

  async connect(queue, voiceChannel) {
    clearTimeout(queue.idleTimer);

    if (queue.connection?.joinConfig.channelId === voiceChannel.id) {
      return queue.connection;
    }

    queue.connection?.destroy();

    queue.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    queue.connection.subscribe(queue.player);

    queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        queue.connection?.destroy();
        queue.connection = null;
        queue.current = null;
        queue.tracks = [];
        this.queues.delete(queue.guildId);
      }
    });

    await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000);
    return queue.connection;
  }

  async getTargetVoiceChannel(interaction) {
    const configuredChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID?.trim();

    if (configuredChannelId) {
      const configuredChannel = await interaction.guild.channels
        .fetch(configuredChannelId)
        .catch(() => null);

      if (isVoiceChannel(configuredChannel)) {
        return configuredChannel;
      }
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    return member?.voice?.channel ?? null;
  }

  playNext(guildId) {
    const queue = this.queues.get(guildId);

    if (!queue) {
      return;
    }

    clearTimeout(queue.idleTimer);

    const track = queue.tracks.shift();

    if (!track) {
      queue.current = null;
      queue.idleTimer = setTimeout(() => {
        const latestQueue = this.queues.get(guildId);

        if (!latestQueue || latestQueue.current || latestQueue.tracks.length > 0) {
          return;
        }

        latestQueue.connection?.destroy();
        this.queues.delete(guildId);
        this.sendQueueMessage(latestQueue, 'Очередь закончилась, выхожу из войса.');
      }, IDLE_LEAVE_MS);
      return;
    }

    queue.current = track;

    try {
      const resource = createYoutubeResource(track);
      const latestQueue = this.queues.get(guildId);

      if (!latestQueue || latestQueue.stopped) {
        resource.playStream?.destroy?.();
        return;
      }

      latestQueue.player.play(resource);
      this.sendQueueMessage(latestQueue, `Играет: ${formatTrack(track)}`);
    } catch (error) {
      console.error(`Failed to create audio resource for ${track.url}:`, error);
      this.sendQueueMessage(queue, `Не смог запустить "${track.title}", пропускаю.`);
      this.playNext(guildId);
    }
  }

  sendQueueMessage(queue, message) {
    if (!queue.textChannelId) {
      return;
    }

    const channel = this.client.channels.cache.get(queue.textChannelId);

    if (channel?.isTextBased()) {
      channel.send(message).catch(() => {});
    }
  }
}

export class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}

function assertVoiceChannel(voiceChannel) {
  if (!voiceChannel) {
    throw new UserFacingError(
      'Зайди в войс-канал или укажи DEFAULT_VOICE_CHANNEL_ID в .env.',
    );
  }
}

async function resolveTracks(query, requestedBy) {
  const trimmed = query.trim();

  if (!trimmed) {
    throw new UserFacingError('Передай ссылку на YouTube или поисковый запрос.');
  }

  const playlistId = extractYouTubePlaylistId(trimmed);

  if (playlistId) {
    return createTracksFromPlaylistId(playlistId, requestedBy);
  }

  const videoId = extractYouTubeVideoId(trimmed);

  if (videoId) {
    return [await createTrackFromVideoId(videoId, requestedBy)];
  }

  if (/^https?:\/\//i.test(trimmed)) {
    throw new UserFacingError('Сейчас поддерживаются только ссылки на YouTube.');
  }

  const videos = await searchYoutubeVideos(trimmed, SEARCH_CANDIDATES_TO_VALIDATE);

  for (const video of videos) {
    try {
      const track = await createTrackFromVideoId(video.videoId, requestedBy, {
        fallbackTitle: video.title,
        fallbackDurationSeconds: video.durationSeconds,
      });

      return [track];
    } catch (error) {
      if (!(error instanceof UserFacingError)) {
        throw error;
      }
    }
  }

  throw new UserFacingError('Нашел видео на YouTube, но ни одно из первых результатов не доступно для проигрывания.');
}

function getYoutubeClient() {
  youtubeClientPromise ??= Innertube.create();
  return youtubeClientPromise;
}

async function searchYoutubeVideos(query, limit) {
  const trimmed = query.trim();

  if (!trimmed) {
    throw new UserFacingError('Передай поисковый запрос.');
  }

  const youtube = await getYoutubeClient();
  const search = await youtube.search(trimmed, { type: 'video' });
  const videos = search.videos ?? [];
  const results = [];

  for (const video of videos) {
    const videoId = normalizeVideoId(video.id);

    if (!videoId) {
      continue;
    }

    results.push({
      videoId,
      title: getText(video.title) ?? 'YouTube video',
      url: getYoutubeWatchUrl(videoId),
      durationSeconds: video.duration?.seconds || null,
    });

    if (results.length >= limit) {
      break;
    }
  }

  if (results.length === 0) {
    throw new UserFacingError('Ничего не нашел на YouTube по этому запросу.');
  }

  return results;
}

async function createTrackFromVideoId(videoId, requestedBy, fallback = {}) {
  const details = await getYtDlpVideoDetails(videoId, fallback);

  return {
    title: details.title,
    url: getYoutubeWatchUrl(videoId),
    durationSeconds: details.durationSeconds,
    requestedBy: requestedBy.tag,
  };
}

async function createTracksFromPlaylistId(playlistId, requestedBy) {
  const playlist = await getYtDlpPlaylistDetails(playlistId);
  const tracks = playlist.entries
    .map((entry) => createTrackFromPlaylistEntry(entry, requestedBy))
    .filter(Boolean);

  if (tracks.length === 0) {
    throw new UserFacingError('В плейлисте не нашел доступных видео.');
  }

  return tracks;
}

function createTrackFromPlaylistEntry(entry, requestedBy) {
  if (!entry) {
    return null;
  }

  const videoId =
    normalizeVideoId(entry.id) ??
    normalizeVideoId(entry.url) ??
    extractYouTubeVideoId(entry.url);

  if (!videoId) {
    return null;
  }

  return {
    title: entry.title ?? 'YouTube video',
    url: getYoutubeWatchUrl(videoId),
    durationSeconds: Number(entry.duration) || null,
    requestedBy: requestedBy.tag,
  };
}

async function getYtDlpPlaylistDetails(playlistId) {
  const url = getYoutubePlaylistUrl(playlistId);

  try {
    const info = await youtubedl(
      url,
      {
        dumpSingleJson: true,
        flatPlaylist: true,
        ignoreErrors: true,
        noWarnings: true,
        socketTimeout: 30,
        extractorRetries: 3,
      },
      {
        timeout: YT_DLP_PLAYLIST_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    return {
      title: info.title ?? 'YouTube playlist',
      entries: Array.isArray(info.entries) ? info.entries : [],
    };
  } catch (error) {
    throw new UserFacingError(`Не могу прочитать YouTube-плейлист: ${formatYtDlpError(error)}.`);
  }
}

async function getYtDlpVideoDetails(videoId, fallback = {}) {
  const url = getYoutubeWatchUrl(videoId);

  try {
    const info = await youtubedl(
      url,
      {
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        socketTimeout: 30,
        extractorRetries: 3,
      },
      {
        timeout: YT_DLP_METADATA_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );

    return {
      title: info.title ?? fallback.fallbackTitle ?? 'YouTube video',
      durationSeconds: Number(info.duration) || fallback.fallbackDurationSeconds || null,
    };
  } catch (error) {
    throw new UserFacingError(`Не могу проиграть это YouTube-видео: ${formatYtDlpError(error)}.`);
  }
}

function createYoutubeResource(track) {
  const ytDlp = spawn(
    youtubedl.constants.YOUTUBE_DL_PATH,
    [
      track.url,
      '--format',
      'bestaudio/best',
      '--output',
      '-',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--retries',
      'infinite',
      '--fragment-retries',
      'infinite',
      '--extractor-retries',
      '10',
      '--file-access-retries',
      '10',
      '--socket-timeout',
      '30',
      '--http-chunk-size',
      '10M',
      '--retry-sleep',
      'http:exp=1:20',
      '--retry-sleep',
      'fragment:exp=1:20',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const ffmpeg = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-acodec',
      'libopus',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'ogg',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  ytDlp.stdout.pipe(ffmpeg.stdin);

  const cleanup = createProcessCleanup([ytDlp, ffmpeg]);
  attachProcessLogging(ytDlp, 'yt-dlp');
  attachProcessLogging(ffmpeg, 'ffmpeg');

  ytDlp.on('error', (error) => ffmpeg.stdout.destroy(error));
  ffmpeg.on('error', (error) => ffmpeg.stdout.destroy(error));
  ffmpeg.stdin.on('error', () => {});

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.OggOpus,
    metadata: track,
  });

  resource.playStream.once('close', cleanup);
  resource.playStream.once('error', cleanup);

  return resource;
}

function attachProcessLogging(childProcess, label) {
  let stderr = '';

  childProcess.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
  });

  childProcess.on('close', (code, signal) => {
    if (childProcess.killedByBot || code === 0) {
      return;
    }

    console.error(`${label} exited with code=${code} signal=${signal ?? 'none'}: ${stderr}`);
  });
}

function createProcessCleanup(processes) {
  let cleaned = false;

  return () => {
    if (cleaned) {
      return;
    }

    cleaned = true;

    for (const childProcess of processes) {
      if (!childProcess || childProcess.killed || childProcess.exitCode !== null) {
        continue;
      }

      childProcess.killedByBot = true;
      childProcess.kill('SIGKILL');
    }
  };
}

function extractYouTubeVideoId(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');

    if (hostname === 'youtu.be') {
      return normalizeVideoId(url.pathname.split('/').filter(Boolean)[0]);
    }

    if (
      hostname === 'youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'music.youtube.com'
    ) {
      const watchId = url.searchParams.get('v');

      if (watchId) {
        return normalizeVideoId(watchId);
      }

      const pathMatch = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      return normalizeVideoId(pathMatch?.[1]);
    }
  } catch {
    return null;
  }

  return null;
}

function extractYouTubePlaylistId(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');

    if (hostname === 'youtu.be') {
      return null;
    }

    if (
      hostname !== 'youtube.com' &&
      hostname !== 'm.youtube.com' &&
      hostname !== 'music.youtube.com'
    ) {
      return null;
    }

    const playlistId = normalizePlaylistId(url.searchParams.get('list'));

    if (!playlistId) {
      return null;
    }

    if (url.pathname.startsWith('/playlist')) {
      return playlistId;
    }

    if (!url.searchParams.get('v') && !extractYouTubeVideoId(value)) {
      return playlistId;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeVideoId(videoId) {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId ?? '') ? videoId : null;
}

function normalizePlaylistId(playlistId) {
  return /^[a-zA-Z0-9_-]+$/.test(playlistId ?? '') ? playlistId : null;
}

function getYoutubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getYoutubePlaylistUrl(playlistId) {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

function getText(value) {
  if (typeof value === 'string') {
    return value;
  }

  return value?.text ?? null;
}

function formatYtDlpError(error) {
  const raw = [error?.stderr, error?.message].filter(Boolean).join('\n');
  const lines = raw
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const usefulLine =
    lines.find((line) => line.startsWith('ERROR:')) ??
    lines.find((line) => !line.startsWith('The command spawned as:'));

  return (
    usefulLine
      ?.replace(/^ERROR:\s*/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 300) || 'видео недоступно или YouTube не отдает аудио'
  );
}

function isVoiceChannel(channel) {
  return (
    channel?.type === ChannelType.GuildVoice ||
    channel?.type === ChannelType.GuildStageVoice
  );
}

function formatTrack(track) {
  const duration = track.durationSeconds ? ` [${formatDuration(track.durationSeconds)}]` : '';
  return `"${track.title}"${duration} (${track.url})`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
