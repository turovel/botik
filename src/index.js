import 'dotenv/config';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import { MusicManager, UserFacingError } from './music.js';

const token = process.env.DISCORD_TOKEN;
const INSULT_GIF_URL = 'https://media.tenor.com/EyeGPrw4TS4AAAAC/jojos-reference.gif';
const INSULT_TRIGGER_PATTERN = /(^|[^\p{L}\p{N}_])пошел\s+нахуй($|[^\p{L}\p{N}_])/iu;
let insultGifBufferPromise;

if (!token) {
  console.error('DISCORD_TOKEN must be set in .env.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const music = new MusicManager(client);
const searchSessions = new Map();
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_SESSION_TTL_MS = 10 * 60 * 1000;

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guild) {
    return;
  }

  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('search:')) {
      await handleSearchButton(interaction);
    }
  } catch (error) {
    await replyWithError(interaction, error);
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) {
    return;
  }

  if (!INSULT_TRIGGER_PATTERN.test(normalizeMessageText(message.content))) {
    return;
  }

  await message.channel
    .send({
      content: `<@${message.author.id}>`,
      files: [await getInsultGifAttachment()],
      allowedMentions: { users: [message.author.id] },
    })
    .catch((error) => {
      console.error('Failed to send insult trigger gif:', error);
    });
});

client.login(token);

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'play': {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const message = await music.enqueue(interaction, query);
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      break;
    }

    case 'search': {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true);
      const results = await music.search(query, SEARCH_RESULT_LIMIT);
      const sessionId = createSearchSession(interaction, results);

      await interaction.editReply({
        content: formatSearchResults(query, results),
        components: buildSearchButtons(sessionId, results.length),
        allowedMentions: { parse: [] },
      });
      break;
    }

    case 'join': {
      await interaction.deferReply();
      const channel = interaction.options.getChannel('channel');
      const message = await music.join(interaction, channel);
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      break;
    }

    case 'skip':
      await interaction.reply({ content: music.skip(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    case 'pause':
      await interaction.reply({ content: music.pause(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    case 'resume':
      await interaction.reply({ content: music.resume(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    case 'stop':
    case 'leave':
      await interaction.reply({ content: music.stop(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    case 'queue':
      await interaction.reply({ content: music.queue(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    case 'nowplaying':
      await interaction.reply({ content: music.nowPlaying(interaction.guildId), allowedMentions: { parse: [] } });
      break;

    default:
      await interaction.reply({
        content: 'Неизвестная команда.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
  }
}

async function handleSearchButton(interaction) {
  const [, sessionId, rawIndex] = interaction.customId.split(':');
  const index = Number(rawIndex);
  const session = searchSessions.get(sessionId);

  if (!session || session.expiresAt <= Date.now()) {
    searchSessions.delete(sessionId);
    throw new UserFacingError('Этот поиск уже истек. Запусти /search еще раз.');
  }

  if (session.guildId !== interaction.guildId) {
    throw new UserFacingError('Этот поиск был создан на другом сервере.');
  }

  if (session.userId !== interaction.user.id) {
    throw new UserFacingError('Это поиск другого пользователя. Запусти свой /search.');
  }

  const result = session.results[index];

  if (!result) {
    throw new UserFacingError('Такого результата поиска уже нет.');
  }

  await interaction.deferReply();

  const message = await music.enqueueVideoId(interaction, result.videoId, {
    fallbackTitle: result.title,
    fallbackDurationSeconds: result.durationSeconds,
  });

  searchSessions.delete(sessionId);
  await interaction.message
    .edit({ components: buildSearchButtons(sessionId, session.results.length, true) })
    .catch(() => {});

  await interaction.editReply({
    content: `Выбрал ${index + 1}. ${message}`,
    allowedMentions: { parse: [] },
  });
}

function createSearchSession(interaction, results) {
  const sessionId = interaction.id;

  searchSessions.set(sessionId, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    results,
    expiresAt: Date.now() + SEARCH_SESSION_TTL_MS,
  });

  setTimeout(() => searchSessions.delete(sessionId), SEARCH_SESSION_TTL_MS).unref();
  return sessionId;
}

function buildSearchButtons(sessionId, count, disabled = false) {
  const rows = [];

  for (let start = 0; start < count; start += 5) {
    const row = new ActionRowBuilder();
    const end = Math.min(start + 5, count);

    for (let index = start; index < end; index += 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`search:${sessionId}:${index}`)
          .setLabel(String(index + 1))
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      );
    }

    rows.push(row);
  }

  return rows;
}

function formatSearchResults(query, results) {
  const lines = [
    `Результаты поиска по "${truncateText(query, 80)}":`,
    'Нажми кнопку с номером, чтобы добавить трек в очередь.',
    '',
  ];

  results.forEach((result, index) => {
    const duration = result.durationSeconds ? `[${formatDuration(result.durationSeconds)}] ` : '';
    lines.push(
      `${index + 1}. ${duration}${truncateText(result.title, 95)} - ${result.url}`,
    );
  });

  return lines.join('\n');
}

function truncateText(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
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

function normalizeMessageText(content) {
  return String(content ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getInsultGifAttachment() {
  insultGifBufferPromise ??= fetch(INSULT_GIF_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`GIF download failed with HTTP ${response.status}`);
      }

      return response.arrayBuffer();
    })
    .then((arrayBuffer) => Buffer.from(arrayBuffer));

  return new AttachmentBuilder(await insultGifBufferPromise, {
    name: 'jojos-reference.gif',
  });
}

async function replyWithError(interaction, error) {
  const content =
    error instanceof UserFacingError
      ? error.message
      : 'Что-то сломалось при выполнении команды. Подробности в консоли.';

  if (!(error instanceof UserFacingError)) {
    const name = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.customId ?? interaction.type;
    console.error(`Interaction ${name} failed:`, error);
  }

  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } }).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}
