import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const body = commands.map((command) => command.toJSON());

try {
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  console.log(
    `Deploying ${body.length} slash commands ${guildId ? `to guild ${guildId}` : 'globally'}...`,
  );

  await rest.put(route, { body });

  console.log('Slash commands deployed.');
} catch (error) {
  console.error('Failed to deploy slash commands:', error);
  process.exit(1);
}
