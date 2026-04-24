const {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require("discord.js");
const fs = require("fs");

// ─── 設定管理 ────────────────────────────────────────────────────────────
const CONFIG_PATH = "./config.json";
const GUILD_CONFIGS_PATH = "./guildConfigs.json";

let { clientId } = require(CONFIG_PATH);

// デフォルト設定
const defaultGuildConfig = {
  settingsChannelId: null,
  channels: {
    welcome: null,
    log: null
  },
  dynamicVC: {
    triggerChannelId: null,
    cleanupCategoryId: null,
    channelName: "{user}のVC",
    userLimit: 0,
    createPanelChannelId: null,
    afkChannelId: null,
    introChannelId: null,
    introWarnMinutes: 1,
    introKickMinutes: 3,
    introCheckChannelId: null,
    introSourceChannelId: null,
    triggerChannelId4: null,
    triggerChannelId5: null
  },
  roles: {
    male: null,
    female: null
  },
  features: {
    introKickEnabled: true,
    genderRoleEnabled: true,
    vcIntroDisplayEnabled: true,
    afkEnabled: true,
    vcPanelEnabled: true,
    vcCreationEnabled: true
  }
};

function loadGuildConfigs() {
  if (fs.existsSync(GUILD_CONFIGS_PATH)) {
    return JSON.parse(fs.readFileSync(GUILD_CONFIGS_PATH, "utf-8"));
  }
  return {};
}

function saveGuildConfigs(configs) {
  fs.writeFileSync(GUILD_CONFIGS_PATH, JSON.stringify(configs, null, 2));
}

function getGuildConfig(guildId) {
  const configs = loadGuildConfigs();
  const guildConfig = configs[guildId] || {};

  // デフォルト設定とマージ（深いマージ）
  return {
    ...defaultGuildConfig,
    ...guildConfig,
    dynamicVC: { ...defaultGuildConfig.dynamicVC, ...(guildConfig.dynamicVC || {}) },
    roles: { ...defaultGuildConfig.roles, ...(guildConfig.roles || {}) },
    features: { ...defaultGuildConfig.features, ...(guildConfig.features || {}) },
    channels: { ...defaultGuildConfig.channels, ...(guildConfig.channels || {}) }
  };
}

function updateGuildConfig(guildId, updateFn) {
  const configs = loadGuildConfigs();
  const current = configs[guildId] || {};
  configs[guildId] = updateFn(current);
  saveGuildConfigs(configs);
}

// ─── ヘルパー関数 ────────────────────────────────────────────────────────────
const createBtn = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const createRow = (...components) => new ActionRowBuilder().addComponents(...components);
const createEmbed = (desc, color = 0x2b2d31, title = null) => {
  const e = new EmbedBuilder().setDescription(desc).setColor(color);
  if (title) e.setTitle(title);
  return e;
};
const autoDelete = (int, ms = 5000) => setTimeout(() => int.deleteReply().catch(() => { }), ms);

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("❌ 環境変数 DISCORD_TOKEN が設定されていません。");
  process.exit(1);
}
const allCommands = require("./commands");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const defaultMessages = {
  "introNotify": "✅ <@{user}> さんの自己紹介を確認しました！",
  "limitLockedWarning": "⚠️ この部屋は作成時に人数が固定されているため、変更できません。",
  "genderMaleOnlyDM": "🚫 {vcName} は ♂️ 男性専用 VCのため入室できません。",
  "genderFemaleOnlyDM": "🚫 {vcName} は ♀️ 女性専用 VCのため入室できません。",
  "introWarnMsg": "⚠️ <@{user}> さん、自己紹介の提出期限が迫っています。\\nあと **{leftMinutes}分** 以内にこのチャンネルに自己紹介を記入しないと、自動的に退出となりますのでご注意ください！",
  "introKickDM": "サーバー参加後、指定された期間内に自己紹介の記入がなかったため、サーバーから自動退出となりました。"
};

let messagesConfig = {};
const msgConfigPath = "./messages.json";
function loadMessages() {
  if (fs.existsSync(msgConfigPath)) {
    messagesConfig = JSON.parse(fs.readFileSync(msgConfigPath, "utf-8"));
    let updated = false;
    for (const [key, val] of Object.entries(defaultMessages)) {
      if (messagesConfig[key] === undefined) {
        messagesConfig[key] = val;
        updated = true;
      }
    }
    if (updated) {
      fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));
    }
  } else {
    messagesConfig = { ...defaultMessages };
    fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));
  }
}
loadMessages();

// ─── 動的VC管理 ───────────────────────────────────────────────────────────────
const tempChannels = new Set();   // Botが作成した一時VC
const profileMessageIds = new Map();   // vcId → プロフィールメッセージID
const controlPanelMsgIds = new Map();  // vcId → コントロールパネルメッセージID
const memberBios = new Map();   // userId → 自己紹介文
const vcOwners = new Map();   // vcId → 部屋主userId
const lockedVCs = new Set();   // ロック中のvcId
const genderMode = new Map();   // vcId → 'male' | 'female' | null  性別制限モード
const pendingRequests = new Map();   // vcId → Map(applicantId → null)
const allowedUsers = new Map();   // vcId → Set(userId)  許可済みユーザー
const knockNotifyMsgIds = new Map();   // vcId → ノック通知メッセージID（1つのメッセージを使い回す）
const introPosted = new Map();   // vcId → Set(userId)
const introMsgIds = new Map();   // vcId_userId → messageId (インチャの自己紹介表示メッセージ)
const limitLockedVCs = new Set();  // vcId → 人数固定されているVCのセット

// ─── VC名プレフィックス管理 ───────────────────────────────────────────────────
const renameTimestamps = new Map(); // vcId -> [timestamp1, timestamp2]

function canRename(vcId) {
  const now = Date.now();
  const stamps = renameTimestamps.get(vcId) || [];
  const validStamps = stamps.filter((t) => now - t < 10 * 60 * 1000);
  renameTimestamps.set(vcId, validStamps);
  return validStamps.length < 2;
}

function addRenameTimestamp(vcId) {
  const stamps = renameTimestamps.get(vcId) || [];
  stamps.push(Date.now());
  renameTimestamps.set(vcId, stamps);
}

async function updateVcName(vc, newBaseName = null, interaction = null) {
  if (newBaseName === null) return true;
  if (newBaseName === vc.name) return true;

  if (!canRename(vc.id)) {
    console.warn(`[VcName] レート制限回避のためスキップ: ${vc.name}`);
    if (interaction) {
      try {
        await interaction.followUp({
          content: "⚠️ **Discordの仕様により、チャンネル名の変更は10分間に2回までとなっています。**\n名前の変更は一時的に制限されていますが、**機能（ロックや性別制限等）自体は正常に適用されています**。",
          ephemeral: true
        });
        setTimeout(() => interaction.deleteReply().catch(() => { }), 15000);
      } catch { }
    }
    return false;
  }

  try {
    await vc.setName(newBaseName);
    addRenameTimestamp(vc.id);
    return true;
  } catch (e) {
    console.warn("[VcName] エラー:", e.message);
    return false;
  }
}

// ─── コマンドをコレクションに登録 ─────────────────────────────────────────────
client.commands = new Collection();
for (const cmd of allCommands) client.commands.set(cmd.data.name, cmd);

// ─── スラッシュコマンドをDiscordへデプロイ ────────────────────────────────────
async function deployCommands() {
  const rest = new REST().setToken(token);
  try {
    // グローバルコマンドとして登録（全てのサーバーで利用可能になる）
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: allCommands.map((c) => c.data.toJSON()) }
    );
    console.log(`✅ [Deploy] グローバルに ${data.length} 件のコマンドを登録しました。`);
  } catch (err) {
    console.error("コマンド登録エラー:", err);
  }
}

// ─── 設定パネルを設置 ────────────────────────────────────────────────────────

async function setupSettingsPanel(guildId, overrideChannelId = null) {
  if (overrideChannelId) {
    updateGuildConfig(guildId, (current) => ({
      ...current,
      settingsChannelId: overrideChannelId
    }));
  }

  const config = getGuildConfig(guildId);
  if (!config.settingsChannelId) return;

  const channel = await client.channels.fetch(config.settingsChannelId).catch(() => null);
  if (!channel) return;

  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
  } catch { }

  const meta = { version: 1, lastUpdated: new Date().toISOString() }; // バージョン管理は簡易化
  const updated = new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  let desc = `-# Version ${meta.version}.0.0 ｜ System: Operational\n\n`;

  desc += `### 🎙️ VC内機能の設定 [Voice Features]\n`;
  desc += `-# AFK / 自己紹介表示 / 部屋制限 の設定です。\n\n`;

  desc += `### 📺 VC作成用チャンネルの設定 [Channel Config]\n`;
  desc += `-# VC作成パネルの設置場所や、自動作成のトリガーの設定です。\n\n`;

  if (config.features.introKickEnabled) {
    desc += `### 📝 自己紹介未提出者整理 [Profile Guard]\n`;
    desc += `-# 未提出者への警告や自動キックの設定です。\n\n`;
  }

  desc += `### 💬 メッセージ設定 [Messages]\n`;
  desc += `-# 各種通知メッセージの編集です。\n`;

  const embed = createEmbed(desc).setTitle("⬛ DIS COORDE | Control Panel").setFooter({ text: `Last Updated: ${updated} (JST)` });
  const rows = [
    createRow(createBtn("cfg_btn_vc_sub", "🎙️ VC内機能の設定"), createBtn("cfg_btn_chan_sub", "📺 VC作成用チャンネルの設定")),
    createRow(createBtn("cfg_btn_intro_kick", "📝 自己紹介未提出者整理"), createBtn("config_messages", "💬 メッセージ設定"))
  ];
  await channel.send({ embeds: [embed], components: rows });
}


// ─── サブパネル用ペイロード生成 ──────────────────────────────────────────────

function getMainSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  let description = ``;

  description += `### 🎙️ VC内機能の設定 [Voice Features]\n`;
  description += `-# AFK / 自己紹介表示 / 部屋制限 の設定です。\n\n`;

  description += `### 📺 VC作成用チャンネルの設定 [Channel Config]\n`;
  description += `-# VC作成パネルの設置場所や、自動作成のトリガーの設定です。\n\n`;

  if (config.features.introKickEnabled) {
    description += `### 📝 自己紹介未提出者整理 [Profile Guard]\n`;
    description += `-# 未提出者への警告や自動キックの設定です。\n\n`;
  }

  description += `### 💬 メッセージ設定 [Messages]\n`;
  description += `-# 各種通知メッセージの編集です。\n`;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("⬛ DIS COORDE | Control Panel")
    .setDescription(description || "（有効な機能がありません）");

  const row1 = createRow(
    createBtn("cfg_btn_vc_sub", "🎙️ VC内機能の設定"),
    createBtn("cfg_btn_chan_sub", "📺 VC作成用チャンネルの設定")
  );

  const row2 = createRow(
    createBtn("cfg_btn_intro_kick", "📝 自己紹介未提出者整理"),
    createBtn("config_messages", "💬 メッセージ設定")
  );

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getVCSubSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const { dynamicVC, roles } = config;

  let description = `### 🎙️ VC内機能の設定 [Voice Features]\n`;
  description += `-# ボイスチャンネル内での動作に関する設定です。\n\n`;

  description += `### 💤 AFK設定\n`;
  description += `> 移動先 ─ ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}\n`;
  description += `-# 一定時間経過後にユーザーをAFKチャンネルへ移動させる設定です。\n\n`;

  description += `### 🖼️ VC内自己紹介表示\n`;
  description += `> 表示ソース ─ ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}\n`;
  description += `-# 入室時に自己紹介文をVC内テキストへ自動転送します。\n\n`;

  description += `### 🚻 部屋制限設定\n`;
  description += `> ♂️ ${roles.male ? `<@&${roles.male}>` : "`未設定`"} / ♀️ ${roles.female ? `<@&${roles.female}>` : "`未設定`"}\n`;
  description += `-# 性別ロールによる入室制限や、人数上限の設定です。\n`;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("🎙️ VC内機能の設定")
    .setDescription(description);

  const row1 = createRow(
    createBtn("cfg_btn_afk", "💤 AFK設定"),
    createBtn("cfg_btn_intro_display", "🖼️ VC内自己紹介表示"),
    createBtn("cfg_btn_vc", "🚻 部屋制限設定")
  );
  const row2 = createRow(createBtn("cfg_back_main", "⬅️ 戻る"));

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getChanSubSettingsPayload(guild) {
  const config = getGuildConfig(guild.id);
  const { dynamicVC } = config;
  const check = (id) => id && guild.channels.cache.has(id) ? `<#${id}>` : "`未設定`";

  let description = `### 📺 VC作成用チャンネルの設定 [Channel Config]\n`;
  description += `-# VC作成の起点となる場所の設定です。\n\n`;

  description += `### 📂 VC作成先カテゴリ\n`;
  description += `> カテゴリ ─ ${check(dynamicVC.cleanupCategoryId)}\n`;
  description += `-# 作成されたVCが配置されるカテゴリです。\n\n`;

  description += `### 🛠️ パネル設置場所\n`;
  description += `> 設置先 ─ ${check(dynamicVC.createPanelChannelId)}\n`;
  description += `-# 「新しい通話を作成」などのボタンを表示するテキストチャンネルです。\n\n`;

  description += `### ➕ VC自動作成\n`;
  description += `> 自由枠 ─ ${check(dynamicVC.triggerChannelId)}\n`;
  description += `> 4人部屋 ─ ${check(dynamicVC.triggerChannelId4)}\n`;
  description += `> 5人部屋 ─ ${check(dynamicVC.triggerChannelId5)}\n`;
  description += `-# 入室すると自動的に専用のVCが作成されるボイスチャンネルです。\n`;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("📺 VC作成用チャンネルの設定")
    .setDescription(description);

  const row1 = createRow(
    createBtn("cfg_btn_category", "📂 VC作成先カテゴリ"),
    createBtn("cfg_btn_panel", "🛠️ パネル設置場所")
  );
  const row2 = createRow(
    createBtn("cfg_btn_trigger", "➕ VC自動作成"),
    createBtn("cfg_back_main", "⬅️ 戻る")
  );

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getAFKSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const en = config.features.afkEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n詳細: ${config.dynamicVC.afkChannelId ? `<#${config.dynamicVC.afkChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_afk", `AFK機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_afk").setPlaceholder(en ? "移動先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "💤 AFK設定")], components: rows, ephemeral: true };
}
function getPanelSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const en = config.features.vcPanelEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n設置先: ${config.dynamicVC.createPanelChannelId ? `<#${config.dynamicVC.createPanelChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_panel", `パネル機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_panel").setPlaceholder(en ? "設置先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_chan_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "🛠️ パネル設置場所")], components: rows, ephemeral: true };
}
function getCategorySettingsPayload(guild) {
  const config = getGuildConfig(guild.id);
  const check = (id) => id && guild.channels.cache.has(id) ? `<#${id}>` : "未設定";
  const desc = `現在のカテゴリ: ${check(config.dynamicVC.cleanupCategoryId)}\n\n作成されたVCが配置されるカテゴリ（フォルダ）を選択してください。`;
  const rows = [
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_category").setPlaceholder("カテゴリを選択").setChannelTypes([ChannelType.GuildCategory])),
    createRow(createBtn("cfg_back_chan_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "📂 VC作成先カテゴリ")], components: rows, ephemeral: true };
}

function getVCCreationSettingsPayload(guild) {
  const config = getGuildConfig(guild.id);
  const en = config.features.vcCreationEnabled;
  const check = (id) => id && guild.channels.cache.has(id) ? `<#${id}>` : "未設定";
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n自由: ${check(config.dynamicVC.triggerChannelId)}\n4人/5人: ${check(config.dynamicVC.triggerChannelId4)} / ${check(config.dynamicVC.triggerChannelId5)}`;
  const rows = [
    createRow(createBtn("toggle_vc_creation", `自動作成機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger").setPlaceholder(en ? "自由枠を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger4").setPlaceholder(en ? "4人部屋を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger5").setPlaceholder(en ? "5人部屋を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(createBtn("cfg_back_chan_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "➕ VC自動作成設定")], components: rows, ephemeral: true };
}
function getIntroKickSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const en = config.features.introKickEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n確認先: ${config.dynamicVC.introCheckChannelId ? `<#${config.dynamicVC.introCheckChannelId}>` : "未設定"}\n警告/実行: ${config.dynamicVC.introWarnMinutes}分 / ${config.dynamicVC.introKickMinutes}分`;
  const rows = [
    createRow(createBtn("toggle_intro_kick", `自動整理: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger), createBtn("config_intro_time", "⏱️ 期限設定", ButtonStyle.Primary, !en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_introcheck").setPlaceholder(en ? "確認先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_main", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x5865f2, "📝 自己紹介未提出者整理")], components: rows, ephemeral: true };
}
function getIntroDisplaySettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const en = config.features.vcIntroDisplayEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\nソース: ${config.dynamicVC.introSourceChannelId ? `<#${config.dynamicVC.introSourceChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_vc_intro", `表示: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_introsource").setPlaceholder(en ? "ソースを選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x5865f2, "🖼️ VC内表示設定")], components: rows, ephemeral: true };
}
function getVCSettingsPayload(guildId) {
  const config = getGuildConfig(guildId);
  const en = config.features.genderRoleEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n♂️ ${config.roles.male ? `<@&${config.roles.male}>` : "未設定"} / ♀️ ${config.roles.female ? `<@&${config.roles.female}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_gender", `部屋制限: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_male").setPlaceholder(en ? "♂️ 男性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_female").setPlaceholder(en ? "♀️ 女性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x57f287, "🎙️ 部屋制限設定")], components: rows, ephemeral: true };
}



// ─── VC作成パネルをテキストチャンネルに設置 ──────────────────────────────────
async function setupCreatePanel(guildId) {
  const config = getGuildConfig(guildId);
  const channelId = config.dynamicVC.createPanelChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 20 });
    for (const msg of messages.filter((m) => m.author.id === client.user.id).values())
      await msg.delete();

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎙️ ボイスチャンネルを作成する")
      .setDescription(
        "下のボタンから作成したいVCの種類を選んでください。\n" +
        "※人数固定の部屋は、作成後に人数の変更ができません。"
      );
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("create_vc_panel").setLabel("➕ 新しい通話を作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("create_vc_4").setLabel("👥 雑談4人部屋作成").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("create_vc_5").setLabel("👥 雑談5人部屋作成").setStyle(ButtonStyle.Primary)
    );
    await channel.send({ embeds: [embed], components: [button] });
    console.log(`[Panel] Guild:${guildId} VC作成パネルを設置しました。`);
  } catch (err) {
    console.error(`[Panel] Guild:${guildId} パネル設置エラー:`, err.message);
  }
}

// ─── プロフィールEmbedを生成 ──────────────────────────────────────────────────
function buildProfileEmbed(member) {
  const joinedAt = member.joinedAt
    ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : "不明";
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`)
    .join(" ") || "なし";
  const bio = memberBios.get(member.id) ?? null;

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || 0x5865f2)
    .setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL({ size: 64 }) })
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "📅 サーバー参加日", value: joinedAt, inline: true },
      { name: "🏷️ ロール", value: roles, inline: false },
    );
  if (bio) embed.addFields({ name: "📝 自己紹介", value: bio, inline: false });
  return embed;
}

// ─── プロフィール一覧メッセージを更新 ────────────────────────────────────────
async function updateProfileMessage(vc) {
  if (!vc) return;
  const members = [...vc.members.values()];
  const msgId = profileMessageIds.get(vc.id);

  if (members.length === 0) {
    if (msgId) {
      try { await (await vc.messages.fetch(msgId)).delete(); } catch { }
      profileMessageIds.delete(vc.id);
    }
    return;
  }

  const embeds = members.map(buildProfileEmbed);
  try {
    if (msgId) {
      try { await (await vc.messages.fetch(msgId)).edit({ embeds }); }
      catch { const s = await vc.send({ embeds }); profileMessageIds.set(vc.id, s.id); }
    } else {
      const s = await vc.send({ embeds }); profileMessageIds.set(vc.id, s.id);
    }
  } catch (err) { console.error("[Profile] 更新エラー:", err.message); }
}

// ─── コントロールパネルのpayloadを生成 ───────────────────────────────────────
function buildPanelPayload(vc) {
  const config = getGuildConfig(vc.guild.id);
  const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id) ?? null, ownerId = vcOwners.get(vc.id), isLimitLocked = limitLockedVCs.has(vc.id);
  const gl = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし", ll = (vc.userLimit ?? 0) === 0 ? "∞ 無制限" : `${vc.userLimit}人`;
  const desc = `### 👑 部屋主 [Owner]\n> <@${ownerId}>\n\n▼ **設定状況 [Status]**\n> 状態 ─ ${locked ? "🔴 **LOCKED**" : "🟢 **OPEN**"}\n> 上限 ─ \`${ll}\`\n> 制限 ─ \`${gl}\`\n\n-# 🛡️ 制限・名前変更は**部屋主のみ**可\n-# 🛏️ お布団は**誰でも**可`;
  if (isLimitLocked) return { embeds: [createEmbed(desc, locked ? 0xe74c3c : 0x57f287)], components: [createRow(createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !config.features.afkEnabled))] };
  const row1 = createRow(createBtn("vc_rename", "✏️ 部屋名変更"), createBtn("vc_toggle_lock", locked ? "🔓 ロック解除" : "🔒 ロックする", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 部屋制限", ButtonStyle.Secondary, !config.features.genderRoleEnabled), createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !config.features.afkEnabled));
  const components = [row1];
  if (locked) components.push(createRow(createBtn("label_knock", "【参加希望】", ButtonStyle.Secondary, true), createBtn(`vc_knock_${vc.id}`, "🚪 ノックして参加をリクエスト", ButtonStyle.Success)));
  return { embeds: [createEmbed(desc, locked ? 0xe74c3c : 0x57f287)], components };
}

function buildVCSettingsPayload(vc) {
  const config = getGuildConfig(vc.guild.id);
  const gender = genderMode.get(vc.id) ?? null, userLimit = vc.userLimit ?? 0;
  const gl = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし", ll = userLimit === 0 ? "∞ 無制限" : `${userLimit}人`;
  const desc = `現在の設定状況:\n> 人数制限 ─ ${ll}\n> 性別制限 ─ ${gl}\n\n下のボタンで設定を変更できます。`;
  const gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = (n) => userLimit === n ? ButtonStyle.Success : ButtonStyle.Secondary, gDis = !config.features.genderRoleEnabled;
  return {
    embeds: [createEmbed(desc, 0x2b2d31, `🛡️ 部屋制限設定 | ${vc.name}`)],
    components: [
      createRow(createBtn("label_g", "【性別】", ButtonStyle.Secondary, true), createBtn("vc_gender_none", "なし", gStyle(null), gDis), createBtn("vc_gender_male", "♂️ 男性", gStyle("male"), gDis), createBtn("vc_gender_female", "♀️ 女性", gStyle("female"), gDis)),
      createRow(createBtn("label_l", "【人数】", ButtonStyle.Secondary, true), createBtn("vc_limit_0", "∞ 無制限", lStyle(0)), createBtn("vc_limit_4", "4人", lStyle(4)), createBtn("vc_limit_5", "5人", lStyle(5)), createBtn("vc_limit_custom", "指定...", ButtonStyle.Primary)),
      createRow(createBtn("vc_main_panel", "⬅️ 戻る"))
    ]
  };
}

// ─── コントロールパネルを初回送信（VC内テキストに投稿） ──────────────────────
async function sendOrUpdateControlPanel(vc) {
  const oldId = controlPanelMsgIds.get(vc.id);
  const payload = buildPanelPayload(vc);

  if (oldId) {
    try {
      const oldMsg = await vc.messages.fetch(oldId);
      await oldMsg.edit(payload);
      return;
    } catch { }
  }

  try {
    const sent = await vc.send(payload);
    controlPanelMsgIds.set(vc.id, sent.id);
  } catch (err) { console.error("[ControlPanel] 送信エラー:", err.message); }
}

// ─── ボタン操作時: interaction.update() でパネルをその場で書き換え ───────────
async function updatePanelViaInteraction(interaction, vc) {
  try {
    await interaction.update(buildPanelPayload(vc));
  } catch (e) {
    console.error("[ControlPanel] interaction.update失敗:", e.message);
    await sendOrUpdateControlPanel(vc);
  }
}

// ─── ノック通知メッセージを更新 ──────────────────────────────────────────────
async function updateKnockNotifyMessage(vc, ownerId) {
  const pending = pendingRequests.get(vc.id);
  const applicantIds = pending ? [...pending.keys()] : [];

  if (applicantIds.length === 0) {
    const msgId = knockNotifyMsgIds.get(vc.id);
    if (msgId) {
      try { await (await vc.messages.fetch(msgId)).delete(); } catch { }
      knockNotifyMsgIds.delete(vc.id);
    }
    return;
  }

  const embeds = applicantIds.map((uid) => {
    const member = vc.guild.members.cache.get(uid);
    return new EmbedBuilder()
      .setColor(0xf39c12)
      .setDescription(`<@${uid}>${member ? `（\`${member.user.tag}\`）` : ""} が入室しようとしています。`)
      .setThumbnail(member?.user.displayAvatarURL({ size: 64 }) ?? null);
  });

  const headerEmbed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle("🚪 ノックされています")
    .setTimestamp();

  const rows = applicantIds.slice(0, 5).map((uid) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`knock_approve_${vc.id}_${uid}`)
        .setLabel("✅ 許可")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`knock_deny_${vc.id}_${uid}`)
        .setLabel("❌ 拒否")
        .setStyle(ButtonStyle.Danger),
    )
  );

  const payload = {
    embeds: [headerEmbed, ...embeds],
    components: rows,
  };

  const msgId = knockNotifyMsgIds.get(vc.id);
  try {
    if (msgId) {
      try {
        await (await vc.messages.fetch(msgId)).edit(payload);
      } catch {
        const s = await vc.send(payload);
        knockNotifyMsgIds.set(vc.id, s.id);
      }
    } else {
      const s = await vc.send(payload);
      knockNotifyMsgIds.set(vc.id, s.id);
    }
  } catch (err) { console.error("[Knock] 通知更新エラー:", err.message); }
}

// ─── 無音返信ヘルパー ─────────────────────────────────────────────────────────
async function silentReply(interaction) {
  try {
    await interaction.reply({ content: "\u200B" });
    await interaction.deleteReply();
  } catch { }
}

// ─── 自己紹介ボタンを送るヘルパー ────────────────────────────────────────────
async function sendBioPrompt(vc, member) {
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bio_input_${member.id}`)
        .setLabel("📝 自己紹介を入力する")
        .setStyle(ButtonStyle.Secondary)
    );
    const msg = await vc.send({
      content: `<@${member.id}> 自己紹介を入力してプロフィールに表示しましょう！（任意）`,
      components: [row],
    });
    setTimeout(async () => { try { await msg.delete(); } catch { } }, 60_000);
  } catch (err) { console.error("[Bio] 送信エラー:", err.message); }
}

// ─── 起動 ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 ${c.user.tag} でログインしました。`);
  await deployCommands();

  // 全てのギルドでパネルをセットアップ
  const configs = loadGuildConfigs();
  for (const guildId of Object.keys(configs)) {
    await setupCreatePanel(guildId);
  }
});

// ギルド参加時にコマンドをデプロイ（念のため）
client.on(Events.GuildCreate, async (guild) => {
  console.log(`🏠 ギルド参加: ${guild.name} (${guild.id})`);
  // グローバルコマンドなので即座には反映されない場合があるが、基本的には全ギルドで使える
});

// ─── インタラクション処理 ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return;
  const config = getGuildConfig(guildId);

  // ── スラッシュコマンド ────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      // setupコマンドのみ特殊処理
      if (interaction.commandName === "setup") {
        global.__setupSettingsPanel = async (cid) => await setupSettingsPanel(guildId, cid);
      }
      await command.execute(interaction);
    }
    catch (err) {
      console.error(err);
      const msg = { content: "コマンドの実行中にエラーが発生しました。", ephemeral: true };
      interaction.replied || interaction.deferred
        ? await interaction.followUp(msg)
        : await interaction.reply(msg);
      setTimeout(() => interaction.deleteReply().catch(() => { }), 10000);
    }
    return;
  }

  // ── ボタン：VC作成パネル → Modal ─────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === "create_vc_panel" || interaction.customId === "create_vc_4" || interaction.customId === "create_vc_5")) {
    // ★ 機能オフ時は拒否
    if (!config.features.vcPanelEnabled) {
      await interaction.reply({ content: "⛔ VC作成パネル機能は現在無効です。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    let title = "🎙️ VCを作成する";
    let defaultName = `${interaction.member.displayName}のVC`;
    let modalId = "create_vc_modal";

    if (interaction.customId === "create_vc_4") {
      title = "👥 雑談4人部屋を作成";
      defaultName = "雑談4人部屋";
      modalId = "create_vc_modal_4";
    } else if (interaction.customId === "create_vc_5") {
      title = "👥 雑談5人部屋を作成";
      defaultName = "雑談5人部屋";
      modalId = "create_vc_modal_5";
    }

    const modal = new ModalBuilder().setCustomId(modalId).setTitle(title);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("create_vc_name").setLabel("ボイスチャンネルの名前")
        .setStyle(TextInputStyle.Short)
        .setValue(defaultName)
        .setMaxLength(100).setRequired(true)
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal：VC作成 ─────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("create_vc_modal")) {
    const vcName = interaction.fields.getTextInputValue("create_vc_name");
    const member = interaction.member;

    let limit = config.dynamicVC.userLimit ?? 0;
    if (interaction.customId === "create_vc_modal_4") limit = 4;
    if (interaction.customId === "create_vc_modal_5") limit = 5;

    await silentReply(interaction);
    try {
      const guild = interaction.guild;
      const categoryId = config.dynamicVC.cleanupCategoryId;
      // カテゴリが存在するか確認
      const parent = categoryId && guild.channels.cache.has(categoryId) ? categoryId : null;

      const newChannel = await guild.channels.create({
        name: vcName,
        type: ChannelType.GuildVoice,
        parent: parent,
        userLimit: limit,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ],
      });
      tempChannels.add(newChannel.id);
      vcOwners.set(newChannel.id, member.id);

      if (limit === 4 || limit === 5) {
        limitLockedVCs.add(newChannel.id);
      }

      console.log(`[Panel] VC作成: ${newChannel.name} by ${member.user.tag}`);
      await sendOrUpdateControlPanel(newChannel);
    } catch (err) { console.error("[Panel] VC作成エラー:", err.message); }
    return;
  }

  // ── ボタン：ロック切替（部屋主のみ） ────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_toggle_lock") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    if (lockedVCs.has(vc.id)) {
      lockedVCs.delete(vc.id);
      console.log(`[Lock] ロック解除: ${vc.name}`);
    } else {
      lockedVCs.add(vc.id);
      console.log(`[Lock] ロック: ${vc.name}`);
    }

    await updatePanelViaInteraction(interaction, vc);
    await updateVcName(vc, null, interaction);
    return;
  }

  // ── ボタン：部屋制限サブメニュー表示 ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_settings_btn") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    // ★ 機能オフ時はサブメニューを開かない
    if (!config.features.genderRoleEnabled) { await interaction.deferUpdate(); return; }

    await interaction.update(buildVCSettingsPayload(vc));
    return;
  }

  // ── ボタン：メインパネルに戻る ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_main_panel") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    await interaction.update(buildPanelPayload(vc));
    return;
  }

  // ── ボタン：性別制限（男性のみ / 女性のみ / 制限なし）────────────────────
  if (interaction.isButton() && ["vc_gender_male", "vc_gender_female", "vc_gender_none"].includes(interaction.customId)) {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    if (!config.features.genderRoleEnabled) { await interaction.deferUpdate(); return; }

    const mode = interaction.customId === "vc_gender_male" ? "male"
      : interaction.customId === "vc_gender_female" ? "female"
        : null;

    const currentMode = genderMode.get(vc.id) ?? null;
    if (mode === currentMode) { await interaction.deferUpdate(); return; }

    if (mode === null) { genderMode.delete(vc.id); } else { genderMode.set(vc.id, mode); }

    await interaction.update(buildVCSettingsPayload(vc));

    try {
      if (mode === null) {
        await vc.permissionOverwrites.set([
          { id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ]);
      } else {
        const allowId = mode === "male" ? config.roles.male : config.roles.female;
        const denyId = mode === "male" ? config.roles.female : config.roles.male;
        await vc.permissionOverwrites.set([
          { id: vc.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: allowId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: denyId, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ]);
      }
    } catch (e) { console.error("[GenderMode] 権限設定エラー:", e.message); }

    await updateVcName(vc, null, interaction);
    console.log(`[GenderMode] 性別制限: ${mode ?? "なし"} (${vc.name})`);
    return;
  }

  // ── ボタン：人数上限（プリセット） ───────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("vc_limit_") && interaction.customId !== "vc_limit_custom") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    if (limitLockedVCs.has(vc.id)) {
      const msg = (messagesConfig["limitLockedWarning"] || "⚠️ この部屋は作成時に人数が固定されているため、変更できません。").replace(/\\n/g, '\n');
      await interaction.reply({ content: msg, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const limit = parseInt(interaction.customId.replace("vc_limit_", ""), 10);
    await vc.setUserLimit(limit);
    await interaction.update(buildVCSettingsPayload(vc));
    console.log(`[Limit] 人数上限変更: ${limit === 0 ? "無制限" : limit + "人"} (${vc.name})`);
    return;
  }

  // ── ボタン：人数上限（カスタム） → Modal ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_limit_custom") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    if (limitLockedVCs.has(vc.id)) {
      const msg = (messagesConfig["limitLockedWarning"] || "⚠️ この部屋は作成時に人数が固定されているため、変更できません。").replace(/\\n/g, '\n');
      await interaction.reply({ content: msg, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const modal = new ModalBuilder().setCustomId(`limit_modal_${vc.id}`).setTitle("🔢 人数上限を設定");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("limit_input").setLabel("人数（0で無制限、最大99）")
        .setStyle(TextInputStyle.Short).setPlaceholder("例: 4").setMaxLength(2).setRequired(true)
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal：人数上限カスタム ────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("limit_modal_")) {
    const vcId = interaction.customId.replace("limit_modal_", "");
    const vc = interaction.guild.channels.cache.get(vcId);
    const input = interaction.fields.getTextInputValue("limit_input").trim();
    await silentReply(interaction);
    if (!vc) return;
    const limit = parseInt(input, 10);
    if (isNaN(limit) || limit < 0 || limit > 99) return;
    await vc.setUserLimit(limit);
    await sendOrUpdateControlPanel(vc);
    console.log(`[Limit] カスタム人数上限: ${limit === 0 ? "無制限" : limit + "人"} (${vc.name})`);
    return;
  }

  // ── ボタン：部屋名変更 → Modal ────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_rename") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    const modal = new ModalBuilder().setCustomId(`rename_modal_${vc.id}`).setTitle("📝 部屋名を変更");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("vc_name_input").setLabel("新しい部屋名")
        .setStyle(TextInputStyle.Short).setPlaceholder("例: みんなの部屋").setMaxLength(100).setRequired(true)
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal：部屋名変更 ─────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("rename_modal_")) {
    const vcId = interaction.customId.replace("rename_modal_", "");
    const vc = interaction.guild.channels.cache.get(vcId);
    const newBase = interaction.fields.getTextInputValue("vc_name_input").replace(/^(?:🔒|♂️|♀️)+/, "").trim();
    await silentReply(interaction);
    if (!vc) return;
    if (!interaction.member.voice.channel || interaction.member.voice.channel.id !== vcId) return;

    await updateVcName(vc, newBase, interaction);
    console.log(`[Rename] ${newBase} by ${interaction.user.tag}`);
    return;
  }

  // ── ボタン：寝落ちした人をAFKへ移動 ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_afk_prompt") {
    if (!config.features.afkEnabled) {
      await interaction.reply({ content: "⛔ AFK機能は現在無効です。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const vc = interaction.member.voice.channel;
    if (!vc || vc.id !== interaction.channelId) {
      await interaction.reply({ content: "⚠️ この操作は、現在このVCに参加している方のみ可能です。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`vc_afk_select_${vc.id}`)
      .setPlaceholder("移動させるユーザーを選択してください")
      .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(userSelect);

    await interaction.reply({
      content: "💤 AFKチャンネルに移動させるユーザーを選んでください。\n（※あなたと同じVCに参加している人のみ選択・移動可能です）",
      components: [row],
      ephemeral: true
    });
    setTimeout(() => interaction.deleteReply().catch(() => { }), 30000);
    return;
  }

  // ── セレクトメニュー：AFKへ移動 ──────────────────────────────────────────
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith("vc_afk_select_")) {
    const vcId = interaction.customId.replace("vc_afk_select_", "");
    const targetUserId = interaction.values[0];

    if (!interaction.member.voice.channel || interaction.member.voice.channelId !== vcId) {
      await interaction.reply({ content: "⚠️ この操作は、現在このVCに参加している方のみ可能です。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember || targetMember.voice.channelId !== vcId) {
      await interaction.reply({ content: "⚠️ 指定されたユーザーはこのVCに参加していません。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    try {
      const AFK_CHANNEL_ID = config.dynamicVC.afkChannelId;
      if (!AFK_CHANNEL_ID) throw new Error("AFKチャンネルが設定されていません。");
      await targetMember.voice.setChannel(AFK_CHANNEL_ID, `寝落ち移動 by ${interaction.user.tag}`);
      await interaction.update({ content: `✅ <@${targetMember.id}> をお布団へ運びました！ゆっくり休んでね💤`, components: [] });
      console.log(`[AFK] ${targetMember.user.tag} をAFKへ移動しました (by ${interaction.user.tag})`);
      setTimeout(() => { interaction.deleteReply().catch(() => { }); }, 3000);
    } catch (err) {
      console.error("[AFK] 移動エラー:", err.message);
      await interaction.update({ content: "⚠️ 移動に失敗しました。BOTの権限やAFKチャンネル設定を確認してください。", components: [] });
    }
    return;
  }

  // ── 設定パネルの期限設定ボタン（Modal表示） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "config_intro_time") {
    if (!config.features.introKickEnabled) {
      await interaction.reply({ content: "⛔ 自動整理機能が無効のため設定できません。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const modal = new ModalBuilder().setCustomId("config_intro_modal").setTitle("⏱️ 自己紹介の期限設定");
    const currentWarn = config.dynamicVC.introWarnMinutes || 1;
    const currentKick = config.dynamicVC.introKickMinutes || 3;

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("warn_minutes").setLabel("警告までの分数")
          .setStyle(TextInputStyle.Short).setValue(String(currentWarn)).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("kick_minutes").setLabel("キックまでの分数")
          .setStyle(TextInputStyle.Short).setValue(String(currentKick)).setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── 設定パネルの期限設定モーダル処理 ────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "config_intro_modal") {
    const warnVal = parseInt(interaction.fields.getTextInputValue("warn_minutes"), 10);
    const kickVal = parseInt(interaction.fields.getTextInputValue("kick_minutes"), 10);

    if (isNaN(warnVal) || isNaN(kickVal) || warnVal < 1 || kickVal <= warnVal) {
      await interaction.reply({ content: "⚠️ 入力値が正しくありません。（分数は1以上、かつキックまでの分数は警告より大きくしてください）", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    updateGuildConfig(guildId, (curr) => ({
      ...curr,
      dynamicVC: { ...curr.dynamicVC, introWarnMinutes: warnVal, introKickMinutes: kickVal }
    }));

    await interaction.update({ content: `✅ 期限タイミングを更新しました！（警告: ${warnVal}分後 / キック: ${kickVal}分後）`, embeds: [], components: [] });
    await setupSettingsPanel(guildId);
    return;
  }

  // ── メッセージ設定 ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "config_messages") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("modal_msg_intro").setLabel("📝 自己紹介関連を編集").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("modal_msg_vc").setLabel("🎙️ VC・制限関連を編集").setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: "📝 **メッセージ設定**\n編集するメッセージのカテゴリを選んでください。\n（※メッセージ設定は現在全サーバー共通です）",
      components: [row],
      ephemeral: true
    });
    return;
  }

  // ── メッセージ編集モーダルを開く ────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === "modal_msg_intro" || interaction.customId === "modal_msg_vc")) {
    const isIntro = interaction.customId === "modal_msg_intro";
    const modalId = isIntro ? "submit_msg_intro" : "submit_msg_vc";
    const title = isIntro ? "📝 自己紹介関連メッセージ" : "🎙️ VC関連メッセージ";
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(title);

    const keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];
    const labels = isIntro ? ["自己紹介確認通知", "自己紹介期限警告", "自己紹介未記入キックDM"] : ["人数固定エラー", "男性専用エラーDM", "女性専用エラーDM"];

    const components = keys.map((key, i) => {
      return new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`input_${key}`)
          .setLabel(labels[i])
          .setStyle(TextInputStyle.Paragraph)
          .setValue((messagesConfig[key] || defaultMessages[key] || "").replace(/\\n/g, '\n'))
          .setRequired(true)
      );
    });
    modal.addComponents(components);
    await interaction.showModal(modal);
    return;
  }

  // ── メッセージ編集モーダルの保存 ────────────────────────────────────────────
  if (interaction.isModalSubmit() && (interaction.customId === "submit_msg_intro" || interaction.customId === "submit_msg_vc")) {
    const isIntro = interaction.customId === "submit_msg_intro";
    const keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];

    for (const key of keys) {
      let newText = interaction.fields.getTextInputValue(`input_${key}`);
      newText = newText.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
      messagesConfig[key] = newText;
    }
    fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));

    await interaction.reply({ content: `✅ メッセージを一括更新しました！`, ephemeral: true });
    setTimeout(() => { interaction.deleteReply().catch(() => { }); }, 3000);
    return;
  }

  // ── ⬅️ ナビゲーション ──────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_back_main") {
    await interaction.update(getMainSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_back_vc_sub") {
    await interaction.update(getVCSubSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_back_chan_sub") {
    await interaction.update(getChanSubSettingsPayload(interaction.guild));
    return;
  }

  // ── サブフォルダ表示 ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_vc_sub") {
    await interaction.update(getVCSubSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_chan_sub") {
    await interaction.update(getChanSubSettingsPayload(interaction.guild));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_category") {
    await interaction.update(getCategorySettingsPayload(interaction.guild));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_afk") {
    await interaction.update(getAFKSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_panel") {
    await interaction.update(getPanelSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_trigger") {
    await interaction.update(getVCCreationSettingsPayload(interaction.guild));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_intro_kick") {
    await interaction.update(getIntroKickSettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_intro_display") {
    await interaction.update(getIntroDisplaySettingsPayload(guildId));
    return;
  }
  if (interaction.isButton() && interaction.customId === "cfg_btn_vc") {
    await interaction.update(getVCSettingsPayload(guildId));
    return;
  }

  // ── トグル処理 ──────────────────────────────────────────
  const toggleMap = {
    toggle_intro_kick: ["introKickEnabled", getIntroKickSettingsPayload],
    toggle_vc_intro: ["vcIntroDisplayEnabled", getIntroDisplaySettingsPayload],
    toggle_afk: ["afkEnabled", getAFKSettingsPayload],
    toggle_panel: ["vcPanelEnabled", getPanelSettingsPayload],
    toggle_vc_creation: ["vcCreationEnabled", getVCCreationSettingsPayload]
  };
  if (interaction.isButton() && toggleMap[interaction.customId]) {
    const [key, fn] = toggleMap[interaction.customId];
    updateGuildConfig(guildId, (curr) => ({
      ...curr,
      features: { ...curr.features, [key]: !curr.features[key] }
    }));
    await interaction.update(fn(guildId));
    await setupSettingsPanel(guildId);
    return;
  }

  if (interaction.isButton() && interaction.customId === "toggle_gender") {
    const newVal = !config.features.genderRoleEnabled;
    updateGuildConfig(guildId, (curr) => ({
      ...curr,
      features: { ...curr.features, genderRoleEnabled: newVal }
    }));
    if (!newVal) {
      for (const vcId of tempChannels) {
        const vc = client.channels.cache.get(vcId);
        if (vc && vc.guild.id === guildId && genderMode.has(vcId)) {
          genderMode.delete(vcId);
          await vc.permissionOverwrites.set([
            { id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
          ]).catch(() => { });
          await sendOrUpdateControlPanel(vc);
        }
      }
    }
    await interaction.update(getVCSettingsPayload(guildId));
    await setupSettingsPanel(guildId);
    return;
  }

  // ── セレクトメニュー更新 ───────────────────────────────────────────
  if (interaction.isAnySelectMenu() && interaction.customId.startsWith("select_cfg_")) {
    const field = interaction.customId.replace("select_cfg_", "");
    const selected = interaction.values[0];
    const map = {
      trigger: ["dynamicVC", "triggerChannelId", "自由枠トリガー"], trigger4: ["dynamicVC", "triggerChannelId4", "4人部屋トリガー"], trigger5: ["dynamicVC", "triggerChannelId5", "5人部屋トリガー"],
      afk: ["dynamicVC", "afkChannelId", "AFKチャンネル"], panel: ["dynamicVC", "createPanelChannelId", "パネル設置チャンネル"],
      category: ["dynamicVC", "cleanupCategoryId", "VC作成先カテゴリ"],
      introcheck: ["dynamicVC", "introCheckChannelId", "自己紹介確認用"], introsource: ["dynamicVC", "introSourceChannelId", "自己紹介ソース用"],
      male: ["roles", "male", "男性ロール"], female: ["roles", "female", "女性ロール"]
    };
    const [sec, key, name] = map[field];

    updateGuildConfig(guildId, (curr) => {
      const next = { ...curr };
      next[sec] = { ...next[sec], [key]: selected };
      return next;
    });

    const mention = (sec === "roles") ? `<@&${selected}>` : `<#${selected}>`;
    await interaction.update({ content: `✅ **${name}** を ${mention} に更新しました！`, embeds: [], components: [] });
    autoDelete(interaction, 15000);
    await setupSettingsPanel(guildId);
    if (field === "panel") await setupCreatePanel(guildId);
    return;
  }

  // ── ノック申請 ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("vc_knock_")) {
    const vcId = interaction.customId.replace("vc_knock_", "");
    const vc = interaction.guild.channels.cache.get(vcId);
    if (!vc || !tempChannels.has(vcId)) { await interaction.deferUpdate(); return; }

    const member = interaction.member;
    const ownerId = vcOwners.get(vcId);

    if (member.voice.channelId === vcId) {
      await interaction.reply({ content: "あなたは既にこの通話に参加しています。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }
    if (ownerId === member.id) {
      await interaction.reply({ content: "部屋主はノックできません。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }
    if (!lockedVCs.has(vcId)) {
      await interaction.reply({ content: "この部屋は現在ロックされていないため、そのまま入室できます。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }
    if (pendingRequests.get(vcId)?.has(member.id)) {
      await interaction.reply({ content: "既にノック申請を送信済みです。部屋主の応答をお待ちください。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    if (!pendingRequests.has(vcId)) pendingRequests.set(vcId, new Map());
    pendingRequests.get(vcId).set(member.id, true);

    await updateKnockNotifyMessage(vc, ownerId);
    await interaction.reply({ content: "✅ 部屋主にノック申請を送信しました！", ephemeral: true });
    setTimeout(() => interaction.deleteReply().catch(() => { }), 10000);
    return;
  }

  // ── 申請許可・拒否 ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("knock_approve_")) {
    const parts = interaction.customId.split("_");
    const vcId = parts[2], applicantId = parts[3];
    const vc = interaction.guild.channels.cache.get(vcId);
    if (vcOwners.get(vcId) !== interaction.user.id || !vc) { await interaction.deferUpdate(); return; }
    await interaction.deferUpdate();
    try {
      const applicant = await interaction.guild.members.fetch(applicantId);
      if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set());
      allowedUsers.get(vcId).add(applicantId);
      pendingRequests.get(vcId)?.delete(applicantId);
      await updateKnockNotifyMessage(vc, interaction.user.id);
      if (applicant.voice.channel) {
        await applicant.voice.setChannel(vc).catch(() => { });
      } else {
        const msg = await vc.send(`✅ <@${applicantId}> さんの参加が許可されました！`).catch(() => null);
        if (msg) setTimeout(() => msg.delete().catch(() => { }), 60000);
      }
    } catch (err) { console.error("[Knock] 許可エラー:", err.message); }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("knock_deny_")) {
    const parts = interaction.customId.split("_"), vcId = parts[2], applicantId = parts[3];
    const vc = interaction.guild.channels.cache.get(vcId);
    if (vcOwners.get(vcId) !== interaction.user.id) { await interaction.deferUpdate(); return; }
    await interaction.deferUpdate();
    pendingRequests.get(vcId)?.delete(applicantId);
    await updateKnockNotifyMessage(vc, interaction.user.id);
    return;
  }

  // ── 自己紹介入力 ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("bio_input_")) {
    const targetId = interaction.customId.replace("bio_input_", "");
    if (interaction.user.id !== targetId) { await interaction.deferUpdate(); return; }
    const modal = new ModalBuilder().setCustomId(`bio_modal_${interaction.user.id}`).setTitle("📝 自己紹介を入力");
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bio_text").setLabel("自己紹介").setStyle(TextInputStyle.Paragraph).setPlaceholder("趣味など").setMaxLength(300).setRequired(false)));
    await interaction.showModal(modal);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("bio_modal_")) {
    const bio = interaction.fields.getTextInputValue("bio_text").trim();
    const member = interaction.member;
    await silentReply(interaction);
    if (bio) memberBios.set(member.id, bio); else memberBios.delete(member.id);
    if (member.voice.channel && tempChannels.has(member.voice.channelId)) await updateProfileMessage(member.voice.channel);
    return;
  }
});

// ─── 動的VC: VoiceStateUpdate ─────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guildId = newState.guild.id;
  const config = getGuildConfig(guildId);

  // トリガーVC
  if (newState.channelId && (
    newState.channelId === config.dynamicVC.triggerChannelId ||
    newState.channelId === config.dynamicVC.triggerChannelId4 ||
    newState.channelId === config.dynamicVC.triggerChannelId5
  )) {
    if (!config.features.vcCreationEnabled) return;
    const member = newState.member, trigger = newState.channel;
    let limit = config.dynamicVC.userLimit ?? 0, isFixed = false, baseName = config.dynamicVC.channelName.replace("{user}", member.displayName);
    if (newState.channelId === config.dynamicVC.triggerChannelId4) { limit = 4; isFixed = true; baseName = "雑談4人部屋"; }
    else if (newState.channelId === config.dynamicVC.triggerChannelId5) { limit = 5; isFixed = true; baseName = "雑談5人部屋"; }
    try {
      const parent = config.dynamicVC.cleanupCategoryId && newState.guild.channels.cache.has(config.dynamicVC.cleanupCategoryId) ? config.dynamicVC.cleanupCategoryId : trigger.parentId;
      const newChannel = await newState.guild.channels.create({
        name: baseName, type: ChannelType.GuildVoice, parent: parent, userLimit: limit,
        permissionOverwrites: [
          { id: newState.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ],
      });
      tempChannels.add(newChannel.id);
      vcOwners.set(newChannel.id, member.id);
      if (isFixed) limitLockedVCs.add(newChannel.id);
      await member.voice.setChannel(newChannel);
      await sendOrUpdateControlPanel(newChannel);
    } catch (err) { console.error("[DynamicVC] 作成エラー:", err.message); }
    return;
  }

  // 入室時
  if (newState.channelId && tempChannels.has(newState.channelId)) {
    const vc = newState.channel, member = newState.member;
    const gender = genderMode.get(vc.id) ?? null;
    if (config.features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== member.id) {
      const reqId = gender === "male" ? config.roles.male : config.roles.female;
      if (!member.roles.cache.has(reqId)) {
        await member.voice.disconnect().catch(() => { });
        const msgStr = (gender === "male" ? messagesConfig["genderMaleOnlyDM"] : messagesConfig["genderFemaleOnlyDM"]).replace(/{vcName}/g, vc.name).replace(/\\n/g, '\n');
        await member.send(msgStr).catch(() => { });
        return;
      }
    }
    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== member.id) {
      if (allowedUsers.get(vc.id)?.has(member.id)) {
        allowedUsers.get(vc.id).delete(member.id);
      } else {
        await member.voice.disconnect().catch(() => { });
        if (!pendingRequests.has(vc.id)) pendingRequests.set(vc.id, new Map());
        if (!pendingRequests.get(vc.id).has(member.id)) {
          pendingRequests.get(vc.id).set(member.id, true);
          await updateKnockNotifyMessage(vc, vcOwners.get(vc.id));
        }
        return;
      }
    }
    // 自己紹介表示
    if (oldState.channelId !== newState.channelId && config.features.vcIntroDisplayEnabled) {
      const db = fs.existsSync("./introDB.json") ? JSON.parse(fs.readFileSync("./introDB.json", "utf-8")) : {};
      const data = db[member.id];
      if (data?.content) {
        if (!introPosted.has(vc.id)) introPosted.set(vc.id, new Set());
        if (!introPosted.get(vc.id).has(member.id)) {
          introPosted.get(vc.id).add(member.id);
          const embed = new EmbedBuilder().setColor(0x2b2d31).setThumbnail(member.user.displayAvatarURL()).setDescription(`## ${member.displayName}\n> ${data.content}`).setFooter({ text: "DIS COORDE Profile System" });
          const m = await vc.send({ embeds: [embed] }).catch(() => null);
          if (m) introMsgIds.set(`${vc.id}_${member.id}`, m.id);
        }
      }
    }
  }

  // 退出時
  if (oldState.channelId && tempChannels.has(oldState.channelId) && oldState.channelId !== newState.channelId) {
    const ch = oldState.channel;
    const key = `${oldState.channelId}_${oldState.member.id}`;
    if (introMsgIds.has(key)) {
      const mid = introMsgIds.get(key);
      if (ch) {
        const m = await ch.messages.fetch(mid).catch(() => null);
        if (m) await m.delete().catch(() => { });
      }
      introMsgIds.delete(key);
      introPosted.get(oldState.channelId)?.delete(oldState.member.id);
    }
    if (ch && ch.members.size === 0) {
      await ch.delete().catch(() => { });
      tempChannels.delete(ch.id);
      profileMessageIds.delete(ch.id);
      controlPanelMsgIds.delete(ch.id);
      lockedVCs.delete(ch.id);
      genderMode.delete(ch.id);
      vcOwners.delete(ch.id);
      pendingRequests.delete(ch.id);
      allowedUsers.delete(ch.id);
      knockNotifyMsgIds.delete(ch.id);
      renameTimestamps.delete(ch.id);
      introPosted.delete(ch.id);
      limitLockedVCs.delete(ch.id);
    } else if (ch && vcOwners.get(ch.id) === oldState.member.id) {
      const next = ch.members.first();
      if (next) {
        vcOwners.set(ch.id, next.id);
        await sendOrUpdateControlPanel(ch);
      }
    }
  }
});

// ─── 自己紹介監視 ──────────────────────────────
const handleIntroUpdate = async (message, eventType = "create") => {
  const isDelete = eventType === "delete";
  if (message.partial && !isDelete) { try { await message.fetch(); } catch (e) { } }
  if (!message.guild || message.author?.bot) return;

  const config = getGuildConfig(message.guild.id);
  const checkChId = config.dynamicVC.introCheckChannelId || config.dynamicVC.introChannelId;
  const sourceChId = config.dynamicVC.introSourceChannelId || config.dynamicVC.introChannelId;

  if (message.channelId !== checkChId && message.channelId !== sourceChId) return;

  const dbPath = "./introDB.json";
  const db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, "utf-8")) : {};
  const userId = message.author.id;

  if (isDelete) {
    if (db[userId]?.messageId === message.id) {
      delete db[userId];
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
      console.log(`[IntroDB] 削除: ${message.author.tag}`);
    }
  } else if (message.channelId === sourceChId) {
    db[userId] = { content: message.content, messageId: message.id, timestamp: new Date().toISOString() };
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log(`[IntroDB] 更新: ${message.author.tag}`);

    if (config.features.introKickEnabled && message.channelId === checkChId) {
      await message.reply(messagesConfig["introNotify"].replace(/{user}/g, userId)).then(m => setTimeout(() => m.delete().catch(() => { }), 10000));
    }
  }
};

client.on(Events.MessageCreate, m => handleIntroUpdate(m, "create"));
client.on(Events.MessageUpdate, (o, n) => handleIntroUpdate(n, "update"));
client.on(Events.MessageDelete, m => handleIntroUpdate(m, "delete"));

// ─── 自己紹介未提出者のキック処理 ──────────────────────────────
async function checkIntros() {
  const configs = loadGuildConfigs();
  const db = fs.existsSync("./introDB.json") ? JSON.parse(fs.readFileSync("./introDB.json", "utf-8")) : {};

  for (const [guildId, config] of Object.entries(configs)) {
    if (!config.features.introKickEnabled) continue;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;

    const members = await guild.members.fetch();
    const now = Date.now();

    for (const member of members.values()) {
      if (member.user.bot) continue;
      if (db[member.id]) continue;

      const stayMs = now - member.joinedTimestamp;
      const warnMs = config.dynamicVC.introWarnMinutes * 60 * 1000;
      const kickMs = config.dynamicVC.introKickMinutes * 60 * 1000;

      if (stayMs >= kickMs) {
        try {
          await member.send(messagesConfig["introKickDM"] || "自己紹介未記入のため退出となりました。").catch(() => { });
          await member.kick("自己紹介未提出");
          console.log(`[IntroKick] Kick: ${member.user.tag} in ${guild.name}`);
        } catch (e) { console.error(`[IntroKick] Kick失敗: ${member.user.tag}`, e.message); }
      } else if (stayMs >= warnMs) {
        const checkCh = await guild.channels.fetch(config.dynamicVC.introCheckChannelId).catch(() => null);
        if (checkCh) {
          const leftMin = Math.ceil((kickMs - stayMs) / (60 * 1000));
          const msg = (messagesConfig["introWarnMsg"] || "⚠️ 自己紹介を記入してください").replace(/{user}/g, member.id).replace(/{leftMinutes}/g, leftMin).replace(/\\n/g, '\n');
          // 重複送信防止のため、過去のメッセージを確認するなどの処理が望ましいが、ここでは簡易化
        }
      }
    }
  }
}
setInterval(checkIntros, 60000);

client.login(token);
