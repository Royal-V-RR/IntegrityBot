'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('Missing TOKEN environment variable.');
  process.exit(1);
}

// Set to false to let any member use /create (the bot still needs permissions).
const REQUIRE_PERMISSIONS = true;

const COLOR = 0x7c5cff;
const GREEN = 0x57f287;
const RED = 0xed4245;
const FOOTER = { text: 'Integrity Bot' };

// ---------------------------------------------------------------------------
// What can be created
// ---------------------------------------------------------------------------
const KINDS = {
  text: {
    label: 'Text Channel',
    emoji: '💬',
    desc: 'A place for messages',
    type: ChannelType.GuildText,
    group: 'channel',
    textName: true,
    topic: true,
  },
  voice: {
    label: 'Voice Channel',
    emoji: '🔊',
    desc: 'A place to talk',
    type: ChannelType.GuildVoice,
    group: 'channel',
    limit: true,
  },
  announcement: {
    label: 'Announcement Channel',
    emoji: '📢',
    desc: 'Community servers only',
    type: ChannelType.GuildAnnouncement,
    group: 'channel',
    textName: true,
    topic: true,
  },
  forum: {
    label: 'Forum Channel',
    emoji: '🗂️',
    desc: 'Community servers only',
    type: ChannelType.GuildForum,
    group: 'channel',
    textName: true,
    topic: true,
  },
  stage: {
    label: 'Stage Channel',
    emoji: '🎙️',
    desc: 'Community servers only',
    type: ChannelType.GuildStageVoice,
    group: 'channel',
  },
  category: {
    label: 'Category',
    emoji: '📁',
    desc: 'A group for channels',
    type: ChannelType.GuildCategory,
    group: 'category',
  },
  role: {
    label: 'Cosmetic Role',
    emoji: '🎨',
    desc: 'Color and name only, no permissions',
    group: 'role',
  },
};

// ---------------------------------------------------------------------------
// Pending creations, keyed by the menu message id
// ---------------------------------------------------------------------------
const pending = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, state] of pending) if (state.at < cutoff) pending.delete(id);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const embed = (color = COLOR) => new EmbedBuilder().setColor(color).setFooter(FOOTER);

const fail = (text) => ({
  embeds: [embed(RED).setTitle('Hold on').setDescription(text)],
  flags: MessageFlags.Ephemeral,
});

function missing(i, group) {
  const need = group === 'role' ? PermissionFlagsBits.ManageRoles : PermissionFlagsBits.ManageChannels;
  const label = group === 'role' ? 'Manage Roles' : 'Manage Channels';
  if (REQUIRE_PERMISSIONS && !i.memberPermissions?.has(need)) {
    return `You need the **${label}** permission to create this.`;
  }
  if (!i.guild?.members.me?.permissions.has(need)) {
    return `I need the **${label}** permission in this server.`;
  }
  return null;
}

function cleanName(kind, raw) {
  let name = String(raw || '').trim();
  if (kind.textName) {
    name = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .replace(/-+/g, '-');
  }
  return name.slice(0, 100);
}

function parseColor(raw) {
  const v = String(raw || '').trim().replace(/^#/, '');
  if (!v) return { ok: true, value: 0 };
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  if (!/^[0-9a-f]{6}$/i.test(full)) return { ok: false, value: 0 };
  return { ok: true, value: parseInt(full, 16) };
}

const isYes = (raw) => /^(y|yes|true|1|on)$/i.test(String(raw || '').trim());

function field(id, label, { style = TextInputStyle.Short, required = false, max = 100, placeholder } = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(input);
}

// ---------------------------------------------------------------------------
// UI builders
// ---------------------------------------------------------------------------
function menuPayload() {
  const lines = Object.values(KINDS).map((k) => `${k.emoji} **${k.label}**  ${k.desc}`);
  return {
    embeds: [
      embed()
        .setTitle('✨ Create something new')
        .setDescription(`Pick what you want to make from the menu below.\n\n${lines.join('\n')}`),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ib:type')
          .setPlaceholder('What would you like to create?')
          .addOptions(
            Object.entries(KINDS).map(([value, k]) => ({
              label: k.label,
              description: k.desc,
              emoji: k.emoji,
              value,
            })),
          ),
      ),
    ],
  };
}

function buildModal(key) {
  const k = KINDS[key];
  const modal = new ModalBuilder().setCustomId(`ib:modal:${key}`).setTitle(`New ${k.label}`);
  const rows = [
    field('name', 'Name', {
      required: true,
      placeholder: key === 'role' ? 'Night Owls' : k.textName ? 'general chat' : 'Lounge',
    }),
  ];
  if (k.topic) {
    rows.push(field('topic', 'Topic (optional)', { style: TextInputStyle.Paragraph, max: 1024 }));
  }
  if (k.limit) {
    rows.push(field('limit', 'User limit, 0 for none (optional)', { max: 2, placeholder: '0' }));
  }
  if (key === 'role') {
    rows.push(field('color', 'Color hex (optional)', { max: 7, placeholder: '#ff66aa' }));
    rows.push(field('hoist', 'Show separately in the list? (yes or no)', { max: 3, placeholder: 'no' }));
  }
  return modal.addComponents(...rows);
}

function previewPayload(state) {
  const k = KINDS[state.key];
  const e = embed(state.color || COLOR)
    .setTitle(`${k.emoji} Review your ${k.label}`)
    .setDescription('Check the details, then press **Create**.');

  const shownName = k.textName ? `#${state.name}` : state.name;
  e.addFields({ name: 'Name', value: `\`${shownName}\``, inline: true });

  if (k.topic) e.addFields({ name: 'Topic', value: state.topic || 'None', inline: true });
  if (k.limit) e.addFields({ name: 'User limit', value: state.limit ? String(state.limit) : 'No limit', inline: true });
  if (k.group === 'channel') {
    e.addFields({ name: 'Category', value: state.parentId ? `<#${state.parentId}>` : 'None', inline: true });
  }
  if (state.key === 'role') {
    e.addFields(
      { name: 'Color', value: state.color ? `#${state.color.toString(16).padStart(6, '0')}` : 'Default', inline: true },
      { name: 'Shown separately', value: state.hoist ? 'Yes' : 'No', inline: true },
      { name: 'Give it to me', value: state.giveMe ? 'Yes' : 'No', inline: true },
    );
  }

  const components = [];

  if (k.group === 'channel') {
    const picker = new ChannelSelectMenuBuilder()
      .setCustomId('ib:cat')
      .setPlaceholder('Choose a category (optional)')
      .setChannelTypes(ChannelType.GuildCategory)
      .setMinValues(1)
      .setMaxValues(1);
    if (state.parentId) picker.setDefaultChannels(state.parentId);
    components.push(new ActionRowBuilder().addComponents(picker));
  }

  const buttons = [
    new ButtonBuilder().setCustomId('ib:create').setLabel('Create').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ib:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ib:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
  ];
  if (k.group === 'channel' && state.parentId) {
    buttons.push(new ButtonBuilder().setCustomId('ib:clearcat').setLabel('Clear category').setStyle(ButtonStyle.Secondary));
  }
  if (state.key === 'role') {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('ib:giveme')
        .setLabel(state.giveMe ? 'Give it to me: On' : 'Give it to me: Off')
        .setStyle(state.giveMe ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }
  components.push(new ActionRowBuilder().addComponents(buttons));

  return { embeds: [e], components };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------
async function perform(i, state) {
  const k = KINDS[state.key];
  const reason = `Created with Integrity Bot by ${i.user.tag}`;
  const problem = missing(i, k.group);
  if (problem) throw new Error(problem.replace(/\*\*/g, ''));

  if (state.key === 'role') {
    const role = await i.guild.roles.create({
      name: state.name,
      color: state.color || undefined,
      hoist: state.hoist,
      mentionable: false,
      permissions: [],
      reason,
    });
    if (state.giveMe) await i.member.roles.add(role, reason);
    return { text: `<@&${role.id}>`, color: role.color || GREEN };
  }

  const options = { name: state.name, type: k.type, reason };
  if (k.topic && state.topic) options.topic = state.topic;
  if (k.limit && state.limit) options.userLimit = state.limit;
  if (k.group === 'channel' && state.parentId) options.parent = state.parentId;

  const channel = await i.guild.channels.create(options);
  return { text: k.group === 'category' ? `**${channel.name}**` : `<#${channel.id}>`, color: GREEN };
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------
async function onCommand(i) {
  if (!i.inGuild()) return i.reply(fail('Use this command inside a server.'));
  return i.reply({ ...menuPayload(), flags: MessageFlags.Ephemeral });
}

async function onTypeSelect(i) {
  const key = i.values[0];
  const k = KINDS[key];
  if (!k) return;
  const problem = missing(i, k.group);
  if (problem) return i.reply(fail(problem));
  return i.showModal(buildModal(key));
}

async function onModal(i) {
  const key = i.customId.split(':')[2];
  const k = KINDS[key];
  if (!k) return;
  if (!i.isFromMessage()) return i.reply(fail('Please start from /create.'));

  const problem = missing(i, k.group);
  if (problem) return i.reply(fail(problem));

  const name = cleanName(k, i.fields.getTextInputValue('name'));
  if (!name) return i.reply(fail('That name has no usable characters. Try letters or numbers.'));

  const state = {
    key,
    userId: i.user.id,
    name,
    topic: '',
    limit: 0,
    color: 0,
    hoist: false,
    parentId: null,
    giveMe: false,
    at: Date.now(),
  };

  if (k.topic) state.topic = i.fields.getTextInputValue('topic').trim().slice(0, 1024);

  if (k.limit) {
    const raw = i.fields.getTextInputValue('limit').trim();
    if (raw) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 99) return i.reply(fail('User limit must be a whole number from 0 to 99.'));
      state.limit = n;
    }
  }

  if (key === 'role') {
    const parsed = parseColor(i.fields.getTextInputValue('color'));
    if (!parsed.ok) return i.reply(fail('That color is not valid. Use a hex code like `#ff66aa`.'));
    state.color = parsed.value;
    state.hoist = isYes(i.fields.getTextInputValue('hoist'));
  }

  pending.set(i.message.id, state);
  return i.update(previewPayload(state));
}

async function onComponent(i) {
  const state = pending.get(i.message.id);

  if (i.customId === 'ib:back') {
    pending.delete(i.message.id);
    return i.update(menuPayload());
  }

  if (i.customId === 'ib:cancel') {
    pending.delete(i.message.id);
    return i.update({
      embeds: [embed().setTitle('Cancelled').setDescription('Nothing was created. Run `/create` any time.')],
      components: [],
    });
  }

  if (!state) {
    return i.update({
      embeds: [embed(RED).setTitle('This menu expired').setDescription('Run `/create` again to start over.')],
      components: [],
    });
  }

  if (i.isChannelSelectMenu() && i.customId === 'ib:cat') {
    state.parentId = i.values[0];
    return i.update(previewPayload(state));
  }

  if (i.customId === 'ib:clearcat') {
    state.parentId = null;
    return i.update(previewPayload(state));
  }

  if (i.customId === 'ib:giveme') {
    state.giveMe = !state.giveMe;
    return i.update(previewPayload(state));
  }

  if (i.customId === 'ib:create') {
    await i.deferUpdate();
    try {
      const result = await perform(i, state);
      pending.delete(i.message.id);
      return i.editReply({
        embeds: [
          embed(result.color)
            .setTitle('🎉 All done')
            .setDescription(`${KINDS[state.key].label} created: ${result.text}`),
        ],
        components: [],
      });
    } catch (err) {
      console.error('Create failed:', err);
      const payload = previewPayload(state);
      payload.embeds.push(
        embed(RED).setTitle('Could not create it').setDescription(String(err.message || err).slice(0, 1000)),
      );
      return i.editReply(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const command = new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create channels, categories and cosmetic roles')
    .setContexts(InteractionContextType.Guild);
  await c.application.commands.set([command.toJSON()]);
  console.log(`Integrity Bot is online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'create') return await onCommand(i);
    if (i.isStringSelectMenu() && i.customId === 'ib:type') return await onTypeSelect(i);
    if (i.isModalSubmit() && i.customId.startsWith('ib:modal:')) return await onModal(i);
    if ((i.isButton() || i.isChannelSelectMenu()) && i.customId.startsWith('ib:')) return await onComponent(i);
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (i.deferred || i.replied) await i.followUp(fail('Something went wrong. Please try again.'));
      else await i.reply(fail('Something went wrong. Please try again.'));
    } catch {
      // Nothing else we can do.
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(TOKEN);
