import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { MusicManager, UserFacingError } from './music.js';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN must be set in .env.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const music = new MusicManager(client);

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) {
    return;
  }

  try {
    switch (interaction.commandName) {
      case 'play': {
        await interaction.deferReply();
        const query = interaction.options.getString('query', true);
        const message = await music.enqueue(interaction, query);
        await interaction.editReply(message);
        break;
      }

      case 'join': {
        await interaction.deferReply();
        const channel = interaction.options.getChannel('channel');
        const message = await music.join(interaction, channel);
        await interaction.editReply(message);
        break;
      }

      case 'skip':
        await interaction.reply(music.skip(interaction.guildId));
        break;

      case 'pause':
        await interaction.reply(music.pause(interaction.guildId));
        break;

      case 'resume':
        await interaction.reply(music.resume(interaction.guildId));
        break;

      case 'stop':
      case 'leave':
        await interaction.reply(music.stop(interaction.guildId));
        break;

      case 'queue':
        await interaction.reply(music.queue(interaction.guildId));
        break;

      case 'nowplaying':
        await interaction.reply(music.nowPlaying(interaction.guildId));
        break;

      default:
        await interaction.reply({ content: 'Неизвестная команда.', ephemeral: true });
    }
  } catch (error) {
    const content =
      error instanceof UserFacingError
        ? error.message
        : 'Что-то сломалось при выполнении команды. Подробности в консоли.';

    if (!(error instanceof UserFacingError)) {
      console.error(`Command /${interaction.commandName} failed:`, error);
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(token);
