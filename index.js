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
const { clientId, guildId, dynamicVC, roles, features: featuresConfig } = require("./config.json");
// 機能ON/OFFフラグ（config.jsonのfeaturesから読み込み、実行時に変更可能）
const features = Object.assign({
  introKickEnabled: true,
  genderRoleEnabled: true,
  vcIntroDisplayEnabled: true,
  afkEnabled: true,
  vcPanelEnabled: true,
  vcCreationEnabled: true
}, featuresConfig || {});

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
    const data = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: allCommands.map((c) => c.data.toJSON()) }
    );
    console.log(`✅ ${data.length} 件のスラッシュコマンドを登録しました。`);
  } catch (err) {
    console.error("コマンド登録エラー:", err);
  }
}

// ─── 設定パネルを設置 ────────────────────────────────────────────────────────

function saveFeatures() {
  const configPath = "./config.json";
  const fileData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  fileData.features = { ...features };
  fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2));
}

function bumpPanelVersion() {
  const configPath = "./config.json";
  const fileData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const meta = fileData.meta || { version: 0, lastUpdated: null };
  meta.version = (meta.version || 0) + 1;
  meta.lastUpdated = new Date().toISOString();
  fileData.meta = meta;
  fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2));
  return meta;
}

async function setupSettingsPanel(overrideId) {
  if (overrideId) {
    const data = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    data.settingsChannelId = overrideId;
    fs.writeFileSync("./config.json", JSON.stringify(data, null, 2));
  }
  const channel = client.channels.cache.get(require("./config.json").settingsChannelId);
  if (!channel) return;
  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
  } catch { }

  const meta = bumpPanelVersion(), updated = new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  let desc = `-# Version ${meta.version}.0.0 ｜ System: Operational\n\n`;

  if (features.introKickEnabled) {
    desc += `### 📝 自己紹介未提出者整理 [Profile Guard]\n> 確認: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n> 警告/実行: ${dynamicVC.introWarnMinutes ?? 2880}分 / ${dynamicVC.introKickMinutes ?? 4320}分後\n\n`;
  }
  desc += `### 📺 チャンネル設定 [Channel Config]\n> 作成パネル / 自動作成トリガー\n\n`;
  desc += `### 🎙️ VC内機能設定 [Voice Features]\n> AFK / 自己紹介表示 / 部屋制限\n\n`;

  const embed = createEmbed(desc).setTitle("⬛ DIS COORDE | Control Panel").setFooter({ text: `Last Updated: ${updated} (JST)` });
  const rows = [
    createRow(createBtn("cfg_btn_vc_sub", "🎙️ VC機能設定"), createBtn("cfg_btn_chan_sub", "📺 チャンネル設定"), createBtn("cfg_btn_intro_kick", "📝 自己紹介未提出者整理")),
    createRow(createBtn("config_messages", "💬 メッセージ設定"))
  ];
  await channel.send({ embeds: [embed], components: rows });
}


// ─── サブパネル用ペイロード生成 ──────────────────────────────────────────────

function getMainSettingsPayload() {
  let description = ``;

  if (features.introKickEnabled) {
    description += `### 📝 自己紹介未提出者整理 [Profile Guard]\n`;
    description += `-# 未提出者への警告や自動キックの設定です。\n`;
    description += `- 提出確認チャンネル: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n`;
    description += `> 警告 ─ 参加から ${dynamicVC.introWarnMinutes ?? 2880} 分後\n`;
    description += `> 実行 ─ 参加から ${dynamicVC.introKickMinutes ?? 4320} 分後\n\n`;
  }

  description += `### 📺 チャンネル設定 [Channel Config]\n`;
  description += `-# VC作成パネルの設置場所や、作成トリガーとなるVCの設定です。\n\n`;

  description += `### 🎙️ VC内機能設定 [Voice Features]\n`;
  description += `-# AFK / 自己紹介表示 / 部屋制限 の設定です。\n`;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("⬛ DIS COORDE | Control Panel")
    .setDescription(description || "（有効な機能がありません）");

  const row1 = createRow(
    createBtn("cfg_btn_vc_sub", "🎙️ VC機能設定"),
    createBtn("cfg_btn_chan_sub", "📺 チャンネル設定"),
    createBtn("cfg_btn_intro_kick", "📝 自己紹介未提出者整理")
  );

  const row2 = createRow(
    createBtn("config_messages", "💬 メッセージ設定")
  );

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getChanSubSettingsPayload() {
  let description = `### 📺 チャンネル設定 [Channel Config]\n`;
  description += `-# VC作成の起点となる場所の設定です。\n\n`;

  if (features.vcPanelEnabled) {
    description += `### 🛠️ VC作成パネルの設置\n`;
    description += `-# 「新しい通話を作成」などのボタンを表示するテキストチャンネルです。\n`;
    description += `> 設置先 ─ ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}\n\n`;
  }

  if (features.vcCreationEnabled) {
    description += `### ➕ VC自動作成のトリガー\n`;
    description += `-# 入室すると自動的に専用のVCが作成されるボイスチャンネルです。\n`;
    description += `> 自由枠 ─ ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"}\n`;
    description += `> 4人部屋 ─ ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"}\n`;
    description += `> 5人部屋 ─ ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}\n\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("📺 チャンネル設定")
    .setDescription(description || "（有効な機能がありません）");

  const row1 = createRow(
    createBtn("cfg_btn_panel", "🛠️ パネル設置場所"),
    createBtn("cfg_btn_trigger", "➕ 自動作成トリガー")
  );
  const row2 = createRow(createBtn("cfg_back_main", "⬅️ 戻る"));

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getVCSubSettingsPayload() {
  let description = `### 🎙️ VC内機能設定 [Voice Features]\n`;
  description += `-# ボイスチャンネル内での動作に関する設定です。\n\n`;

  if (features.afkEnabled) {
    description += `### 💤 AFK設定\n`;
    description += `> 移動先 ─ ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}\n\n`;
  }

  if (features.vcIntroDisplayEnabled) {
    description += `### 🖼️ VC内自己紹介表示\n`;
    description += `-# 入室時に自己紹介文をVC内テキストへ自動転送します。\n`;
    description += `> 表示用ソース ─ ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}\n\n`;
  }

  if (features.genderRoleEnabled) {
    description += `### 🚻 部屋制限\n`;
    description += `-# 性別ロールによる入室制限の設定です。\n`;
    description += `> ♂️ ${roles.male ? `<@&${roles.male}>` : "`未設定`"} / ♀️ ${roles.female ? `<@&${roles.female}>` : "`未設定`"}\n`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("🎙️ VC内機能設定")
    .setDescription(description || "（有効な機能がありません）");

  const row1 = createRow(
    createBtn("cfg_btn_afk", "💤 AFK設定"),
    createBtn("cfg_btn_intro_display", "🖼️ VC内自己紹介表示"),
    createBtn("cfg_btn_vc", "🚻 部屋制限")
  );
  const row2 = createRow(createBtn("cfg_back_main", "⬅️ 戻る"));

  return { content: null, embeds: [embed], components: [row1, row2], ephemeral: true };
}

function getAFKSettingsPayload() {
  const en = features.afkEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n詳細: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_afk", `AFK機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_afk").setPlaceholder(en ? "移動先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "💤 AFK設定")], components: rows, ephemeral: true };
}
function getPanelSettingsPayload() {
  const en = features.vcPanelEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n設置先: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_panel", `パネル機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_panel").setPlaceholder(en ? "設置先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_chan_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "🛠️ パネル設置場所")], components: rows, ephemeral: true };
}
function getVCCreationSettingsPayload() {
  const en = features.vcCreationEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n自由: ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "未設定"}\n4人/5人: ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "未設定"} / ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_vc_creation", `自動作成機能: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger").setPlaceholder(en ? "自由枠を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger4").setPlaceholder(en ? "4人部屋を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger5").setPlaceholder(en ? "5人部屋を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en)),
    createRow(createBtn("cfg_back_chan_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x2b2d31, "➕ VC自動作成設定")], components: rows, ephemeral: true };
}
function getIntroKickSettingsPayload() {
  const en = features.introKickEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n確認先: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "未設定"}\n警告/実行: ${dynamicVC.introWarnMinutes}分 / ${dynamicVC.introKickMinutes}分`;
  const rows = [
    createRow(createBtn("toggle_intro_kick", `自動整理: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger), createBtn("config_intro_time", "⏱️ 期限設定", ButtonStyle.Primary, !en)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_introcheck").setPlaceholder(en ? "確認先を選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_main", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x5865f2, "📝 自己紹介未提出者整理")], components: rows, ephemeral: true };
}
function getIntroDisplaySettingsPayload() {
  const en = features.vcIntroDisplayEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\nソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_vc_intro", `表示: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new ChannelSelectMenuBuilder().setCustomId("select_cfg_introsource").setPlaceholder(en ? "ソースを選択" : "⛔ 無効").setChannelTypes([ChannelType.GuildText]).setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x5865f2, "🖼️ VC内表示設定")], components: rows, ephemeral: true };
}
function getVCSettingsPayload() {
  const en = features.genderRoleEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n♂️ ${roles.male ? `<@&${roles.male}>` : "未設定"} / ♀️ ${roles.female ? `<@&${roles.female}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_gender", `部屋制限: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_male").setPlaceholder(en ? "♂️ 男性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_female").setPlaceholder(en ? "♀️ 女性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(createBtn("cfg_back_vc_sub", "⬅️ 戻る"))
  ];
  return { embeds: [createEmbed(desc, 0x57f287, "🎙️ 部屋制限設定")], components: rows, ephemeral: true };
}



// ─── VC作成パネルをテキストチャンネルに設置 ──────────────────────────────────
async function setupCreatePanel() {
  const channelId = dynamicVC.createPanelChannelId;
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
    console.log("[Panel] VC作成パネルを設置しました。");
  } catch (err) {
    console.error("[Panel] パネル設置エラー:", err.message);
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
  const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id) ?? null, ownerId = vcOwners.get(vc.id), isLimitLocked = limitLockedVCs.has(vc.id);
  const gl = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし", ll = (vc.userLimit ?? 0) === 0 ? "∞ 無制限" : `${vc.userLimit}人`;
  const desc = `### 👑 部屋主 [Owner]\n> <@${ownerId}>\n\n▼ **設定状況 [Status]**\n> 状態 ─ ${locked ? "🔴 **LOCKED**" : "🟢 **OPEN**"}\n> 上限 ─ \`${ll}\`\n> 制限 ─ \`${gl}\`\n\n-# 🛡️ 制限・名前変更は**部屋主のみ**可\n-# 🛏️ お布団は**誰でも**可`;
  if (isLimitLocked) return { embeds: [createEmbed(desc, locked ? 0xe74c3c : 0x57f287)], components: [createRow(createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !features.afkEnabled))] };
  const row1 = createRow(createBtn("vc_rename", "✏️ 部屋名変更"), createBtn("vc_toggle_lock", locked ? "🔓 ロック解除" : "🔒 ロックする", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 部屋制限", ButtonStyle.Secondary, !features.genderRoleEnabled), createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !features.afkEnabled));
  const components = [row1];
  if (locked) components.push(createRow(createBtn("label_knock", "【参加希望】", ButtonStyle.Secondary, true), createBtn(`vc_knock_${vc.id}`, "🚪 ノックして参加をリクエスト", ButtonStyle.Success)));
  return { embeds: [createEmbed(desc, locked ? 0xe74c3c : 0x57f287)], components };
}

function buildVCSettingsPayload(vc) {
  const gender = genderMode.get(vc.id) ?? null, userLimit = vc.userLimit ?? 0;
  const gl = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし", ll = userLimit === 0 ? "∞ 無制限" : `${userLimit}人`;
  const desc = `現在の設定状況:\n> 人数制限 ─ ${ll}\n> 性別制限 ─ ${gl}\n\n下のボタンで設定を変更できます。`;
  const gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = (n) => userLimit === n ? ButtonStyle.Success : ButtonStyle.Secondary, gDis = !features.genderRoleEnabled;
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
  await setupCreatePanel();
});

// ─── インタラクション処理 ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── スラッシュコマンド ────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try { await command.execute(interaction); }
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
    if (!features.vcPanelEnabled) {
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

    let limit = dynamicVC.userLimit ?? 0;
    if (interaction.customId === "create_vc_modal_4") limit = 4;
    if (interaction.customId === "create_vc_modal_5") limit = 5;

    await silentReply(interaction);
    try {
      const guild = interaction.guild;
      const categoryId = dynamicVC.cleanupCategoryId;
      const newChannel = await guild.channels.create({
        name: vcName,
        type: ChannelType.GuildVoice,
        parent: categoryId ?? null,
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

    // ★ 機能オフ時はサブメニューを開かない（buildVCSettingsPayloadで無効化されているが念のため）
    if (!features.genderRoleEnabled) { await interaction.deferUpdate(); return; }

    // ★ interaction.update() でメインパネルをサブメニューに置き換え（前の表示が消える）
    await interaction.update(buildVCSettingsPayload(vc));
    return;
  }

  // ── ボタン：メインパネルに戻る ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_main_panel") {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    // ★ interaction.update() でサブメニューをメインパネルに置き換え
    await interaction.update(buildPanelPayload(vc));
    return;
  }

  // ── ボタン：性別制限（男性のみ / 女性のみ / 制限なし）────────────────────
  if (interaction.isButton() && ["vc_gender_male", "vc_gender_female", "vc_gender_none"].includes(interaction.customId)) {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    // ★ 機能オフ時は操作不可
    if (!features.genderRoleEnabled) { await interaction.deferUpdate(); return; }

    const mode = interaction.customId === "vc_gender_male" ? "male"
      : interaction.customId === "vc_gender_female" ? "female"
        : null;

    const currentMode = genderMode.get(vc.id) ?? null;
    if (mode === currentMode) { await interaction.deferUpdate(); return; }

    if (mode === null) { genderMode.delete(vc.id); } else { genderMode.set(vc.id, mode); }

    // ★ サブパネルをその場で更新（前の表示が消える）
    await interaction.update(buildVCSettingsPayload(vc));

    try {
      if (mode === null) {
        await vc.permissionOverwrites.set([
          { id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ]);
      } else {
        const allowId = mode === "male" ? roles.male : roles.female;
        const denyId = mode === "male" ? roles.female : roles.male;
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
    // ★ サブパネルをその場で更新
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
    // ★ 機能オフ時は拒否
    if (!features.afkEnabled) {
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
      const AFK_CHANNEL_ID = dynamicVC.afkChannelId || "1496142556042498278";
      await targetMember.voice.setChannel(AFK_CHANNEL_ID, `寝落ち移動 by ${interaction.user.tag}`);
      await interaction.update({ content: `✅ <@${targetMember.id}> をお布団へ運びました！ゆっくり休んでね💤`, components: [] });
      console.log(`[AFK] ${targetMember.user.tag} をAFKへ移動しました (by ${interaction.user.tag})`);
      setTimeout(() => { interaction.deleteReply().catch(() => { }); }, 3000);
    } catch (err) {
      console.error("[AFK] 移動エラー:", err.message);
      await interaction.update({ content: "⚠️ 移動に失敗しました。BOTの権限などを確認してください。", components: [] });
    }
    return;
  }

  // ── 設定パネルの期限設定ボタン（Modal表示） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "config_intro_time") {
    // ★ 機能オフ時は操作不可（buildPayload側でdisabledにしているが念のため）
    if (!features.introKickEnabled) {
      await interaction.reply({ content: "⛔ 自動整理機能が無効のため設定できません。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const modal = new ModalBuilder().setCustomId("config_intro_modal").setTitle("⏱️ 自己紹介の期限設定");
    const currentWarn = dynamicVC.introWarnMinutes || 2880;
    const currentKick = dynamicVC.introKickMinutes || 4320;

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("warn_minutes").setLabel("警告までの分数 (例: 2880 = 2日)")
          .setStyle(TextInputStyle.Short).setValue(String(currentWarn)).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("kick_minutes").setLabel("キックまでの分数 (例: 4320 = 3日)")
          .setStyle(TextInputStyle.Short).setValue(String(currentKick)).setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── 設定パネルの期限設定モーダル処理 ────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "config_intro_modal") {
    const warnStr = interaction.fields.getTextInputValue("warn_minutes");
    const kickStr = interaction.fields.getTextInputValue("kick_minutes");
    const warnVal = parseInt(warnStr, 10);
    const kickVal = parseInt(kickStr, 10);

    if (isNaN(warnVal) || isNaN(kickVal) || warnVal < 1 || kickVal <= warnVal) {
      await interaction.reply({ content: "⚠️ 入力値が正しくありません。（分数は1以上、かつキックまでの分数は警告より大きくしてください）", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    const configPath = "./config.json";
    const configData = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    configData.dynamicVC.introWarnMinutes = warnVal;
    configData.dynamicVC.introKickMinutes = kickVal;
    dynamicVC.introWarnMinutes = warnVal;
    dynamicVC.introKickMinutes = kickVal;

    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // ★ update() で既存の表示を置き換え（前の表示が消える）
    await interaction.update({ content: `✅ 期限タイミングを更新しました！（警告: ${warnVal}分後 / キック: ${kickVal}分後）`, embeds: [], components: [] });
    await setupSettingsPanel();
    return;
  }

  // ── 設定パネルの各ボタン（メッセージ設定） ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "config_messages") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("modal_msg_intro").setLabel("📝 自己紹介関連を編集").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("modal_msg_vc").setLabel("🎙️ VC・制限関連を編集").setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: "📝 **メッセージ設定**\n編集するメッセージのカテゴリを選んでください。\n一覧で編集できます。（※ `{user}` などの変数は消さずに残してください）",
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

  // ─────────────────────────────────────────────────────────────────────────────
  // ★ 設定パネルの各サブ設定ボタン（既存の表示を消してサブパネルを表示）
  // interaction.reply() ではなく interaction.update() を使って排他的に表示する
  // ─────────────────────────────────────────────────────────────────────────────

  // ── ⬅️ サブパネルからメイン設定パネルへ戻る ──────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_back_main") {
    await interaction.update(getMainSettingsPayload());
    return;
  }

  // ── ⬅️ VC機能設定サブフォルダへ戻る ──────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_back_vc_sub") {
    await interaction.update(getVCSubSettingsPayload());
    return;
  }

  // ── ⬅️ チャンネル設定サブフォルダへ戻る ──────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_back_chan_sub") {
    await interaction.update(getChanSubSettingsPayload());
    return;
  }

  // ── 🎙️ VC機能設定（サブフォルダ） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_vc_sub") {
    await interaction.update(getVCSubSettingsPayload());
    return;
  }

  // ── 📺 チャンネル設定（サブフォルダ） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_chan_sub") {
    await interaction.update(getChanSubSettingsPayload());
    return;
  }

  // ── 💤 AFK設定 ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_afk") {
    // ★ reply()ではなくupdate()で既存メッセージを書き換え → 前のサブパネルが消える
    await interaction.update(getAFKSettingsPayload());
    return;
  }

  // ── 🛠️ パネル設定 ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_panel") {
    await interaction.update(getPanelSettingsPayload());
    return;
  }

  // ── ➕ VC自動作成設定 ──────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_trigger") {
    await interaction.update(getVCCreationSettingsPayload());
    return;
  }

  // ── 📝 未提出者自動整理 ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_intro_kick") {
    await interaction.update(getIntroKickSettingsPayload());
    return;
  }

  // ── 🖼️ VC内自己紹介表示 ───────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_intro_display") {
    await interaction.update(getIntroDisplaySettingsPayload());
    return;
  }

  // ── 🚻 部屋制限（旧: VC機能・性別ロール） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_vc") {
    await interaction.update(getVCSettingsPayload());
    return;
  }

  // ── ON/OFFトグル処理の共通化 ──────────────────────────────────────────
  const toggleMap = {
    toggle_intro_kick: ["introKickEnabled", getIntroKickSettingsPayload],
    toggle_vc_intro: ["vcIntroDisplayEnabled", getIntroDisplaySettingsPayload],
    toggle_afk: ["afkEnabled", getAFKSettingsPayload],
    toggle_panel: ["vcPanelEnabled", getPanelSettingsPayload],
    toggle_vc_creation: ["vcCreationEnabled", getVCCreationSettingsPayload]
  };
  if (interaction.isButton() && toggleMap[interaction.customId]) {
    const [key, fn] = toggleMap[interaction.customId];
    features[key] = !features[key];
    saveFeatures();
    await interaction.update(fn());
    await setupSettingsPanel();
    return;
  }

  // ── ON/OFFトグル：部屋制限機能（特殊処理あり） ─────────────────────────────────
  if (interaction.isButton() && interaction.customId === "toggle_gender") {
    features.genderRoleEnabled = !features.genderRoleEnabled;
    saveFeatures();
    if (!features.genderRoleEnabled) {
      for (const vcId of tempChannels) {
        const vc = client.channels.cache.get(vcId);
        if (vc && genderMode.has(vcId)) {
          genderMode.delete(vcId);
          await vc.permissionOverwrites.set([
            { id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
          ]).catch(() => { });
          await sendOrUpdateControlPanel(vc);
        }
      }
    }
    await interaction.update(getVCSettingsPayload());
    await setupSettingsPanel();
    return;
  }

  // ── セレクトメニューによる設定更新 ───────────────────────────────────────────
  if (interaction.isAnySelectMenu() && interaction.customId.startsWith("select_cfg_")) {
    const field = interaction.customId.replace("select_cfg_", "");
    const selected = interaction.values[0], configPath = "./config.json";
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const map = {
      trigger: ["dynamicVC", "triggerChannelId", "自由枠トリガー"], trigger4: ["dynamicVC", "triggerChannelId4", "4人部屋トリガー"], trigger5: ["dynamicVC", "triggerChannelId5", "5人部屋トリガー"],
      afk: ["dynamicVC", "afkChannelId", "AFKチャンネル"], panel: ["dynamicVC", "createPanelChannelId", "パネル設置チャンネル"],
      introcheck: ["dynamicVC", "introCheckChannelId", "自己紹介確認用"], introsource: ["dynamicVC", "introSourceChannelId", "自己紹介ソース用"],
      male: ["roles", "male", "男性ロール"], female: ["roles", "female", "女性ロール"]
    };
    const [sec, key, name] = map[field];
    data[sec][key] = selected;
    if (sec === "dynamicVC") dynamicVC[key] = selected; else roles[key] = selected;
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));

    const mention = (sec === "roles") ? `<@&${selected}>` : `<#${selected}>`;
    await interaction.update({ content: `✅ **${name}** を ${mention} に更新しました！`, embeds: [], components: [] });
    autoDelete(interaction, 15000);
    await setupSettingsPanel();
    if (field === "panel") await setupCreatePanel();
    return;
  }

  // ── ボタン：通話外からのノック申請 ─────────────────────────────────────────
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
    console.log(`[Knock] ボタンからノック: ${member.user.tag} → ${vc.name}`);
    return;
  }

  // ── ボタン：申請を許可（部屋主のみ） ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("knock_approve_")) {
    const parts = interaction.customId.split("_");
    const vcId = parts[2];
    const applicantId = parts[3];
    const vc = interaction.guild.channels.cache.get(vcId);

    if (vcOwners.get(vcId) !== interaction.user.id) { await interaction.deferUpdate(); return; }
    if (!vc) { await interaction.deferUpdate(); return; }

    await interaction.deferUpdate();

    try {
      const applicant = await interaction.guild.members.fetch(applicantId);

      if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set());
      allowedUsers.get(vcId).add(applicantId);

      pendingRequests.get(vcId)?.delete(applicantId);
      await updateKnockNotifyMessage(vc, interaction.user.id);

      const sendVcNotify = async (msg) => {
        const notifyMsg = await vc.send(msg).catch(() => null);
        if (notifyMsg) setTimeout(() => notifyMsg.delete().catch(() => { }), 60000);
      };

      if (applicant.voice.channel) {
        try {
          await applicant.voice.setChannel(vc);
          console.log(`[Knock] 許可・自動移動: ${applicant.user.tag} → ${vc.name}`);
        } catch (moveErr) {
          console.warn(`[Knock] 自動移動失敗: ${moveErr.message}`);
          await sendVcNotify(`✅ <@${applicantId}> さんの参加が許可されました！入室できます。`);
        }
      } else {
        await sendVcNotify(`✅ <@${applicantId}> さんの参加が許可されました！今すぐ **${vc.name}** に入室できます。`);
        console.log(`[Knock] 許可（インチャ通知）: ${applicant.user.tag} → ${vc.name}`);
      }
    } catch (err) { console.error("[Knock] 許可エラー:", err.message); }
    return;
  }

  // ── ボタン：申請を拒否（部屋主のみ） ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("knock_deny_")) {
    const parts = interaction.customId.split("_");
    const vcId = parts[2];
    const applicantId = parts[3];
    const vc = interaction.guild.channels.cache.get(vcId);

    if (vcOwners.get(vcId) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    await interaction.deferUpdate();

    try {
      const applicant = await interaction.guild.members.fetch(applicantId);

      pendingRequests.get(vcId)?.delete(applicantId);
      await updateKnockNotifyMessage(vc, interaction.user.id);

      console.log(`[Knock] 拒否: ${applicant.user.tag}`);
    } catch (err) { console.error("[Knock] 拒否エラー:", err.message); }
    return;
  }

  // ── ボタン：自己紹介入力 → Modal ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("bio_input_")) {
    const targetId = interaction.customId.replace("bio_input_", "");
    if (interaction.user.id !== targetId) { await interaction.deferUpdate(); return; }

    const modal = new ModalBuilder()
      .setCustomId(`bio_modal_${interaction.user.id}`)
      .setTitle("📝 自己紹介を入力");
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("bio_text")
        .setLabel("自己紹介（VC内のプロフィールに表示されます）")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("趣味・好きなゲームなど自由に書いてください")
        .setMaxLength(300).setRequired(false)
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal：自己紹介保存 ───────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("bio_modal_")) {
    const bio = interaction.fields.getTextInputValue("bio_text").trim();
    const member = interaction.member;
    await silentReply(interaction);
    if (bio) memberBios.set(member.id, bio); else memberBios.delete(member.id);
    const vc = member.voice.channel;
    if (vc && tempChannels.has(vc.id)) await updateProfileMessage(vc);
    console.log(`[Bio] 更新: ${member.user.tag}`);
    return;
  }
});

// ─── 動的VC: VoiceStateUpdate ─────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {

  // ── トリガーVCに入ったとき ────────────────────────────────────────────────
  if (newState.channelId && (
    newState.channelId === dynamicVC.triggerChannelId ||
    newState.channelId === dynamicVC.triggerChannelId4 ||
    newState.channelId === dynamicVC.triggerChannelId5
  )) {
    // ★ VC自動作成機能がオフの場合はスキップ
    if (!features.vcCreationEnabled) return;

    const member = newState.member;
    const trigger = newState.channel;

    let limit = dynamicVC.userLimit ?? 0;
    let isFixedLimit = false;
    let baseName = dynamicVC.channelName.replace("{user}", member.displayName);

    if (newState.channelId === dynamicVC.triggerChannelId4) {
      limit = 4;
      isFixedLimit = true;
      baseName = "雑談4人部屋";
    } else if (newState.channelId === dynamicVC.triggerChannelId5) {
      limit = 5;
      isFixedLimit = true;
      baseName = "雑談5人部屋";
    }

    try {
      const newChannel = await newState.guild.channels.create({
        name: baseName,
        type: ChannelType.GuildVoice,
        parent: trigger.parentId,
        userLimit: limit,
        permissionOverwrites: [
          { id: newState.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ],
      });
      tempChannels.add(newChannel.id);
      vcOwners.set(newChannel.id, member.id);
      if (isFixedLimit) {
        limitLockedVCs.add(newChannel.id);
      }
      console.log(`[DynamicVC] 作成: ${newChannel.name} for ${member.user.tag}`);

      await member.voice.setChannel(newChannel);
      await sendOrUpdateControlPanel(newChannel);
    } catch (err) { console.error("[DynamicVC] 作成エラー:", err.message); }
    return;
  }

  // ── 一時VCに誰かが入ったとき ──────────────────────────────────────────────
  if (newState.channelId && tempChannels.has(newState.channelId)) {
    const vc = newState.channel;
    const member = newState.member;

    // ── 性別制限チェック（機能が有効かつ部屋主以外）────────────────────────
    const gender = genderMode.get(vc.id) ?? null;
    if (features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== member.id) {
      const requiredRoleId = gender === "male" ? roles.male : roles.female;
      if (!member.roles.cache.has(requiredRoleId)) {
        try {
          await member.voice.disconnect();
          try {
            let msgStr = "";
            if (gender === "male") {
              msgStr = messagesConfig["genderMaleOnlyDM"] || "🚫 {vcName} は ♂️ 男性専用 VCのため入室できません。";
            } else {
              msgStr = messagesConfig["genderFemaleOnlyDM"] || "🚫 {vcName} は ♀️ 女性専用 VCのため入室できません。";
            }
            msgStr = msgStr.replace(/{vcName}/g, vc.name).replace(/\\n/g, '\n');
            await member.send(msgStr);
          } catch { }
        } catch { }
        console.log(`[GenderMode] 入室拒否（ロールなし）: ${member.user.tag} → ${vc.name}`);
        return;
      }
    }

    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== member.id) {
      if (allowedUsers.get(vc.id)?.has(member.id)) {
        allowedUsers.get(vc.id).delete(member.id);
      } else {
        try {
          const ownerId = vcOwners.get(vc.id);
          await member.voice.disconnect();

          if (pendingRequests.get(vc.id)?.has(member.id)) {
            console.log(`[Lock] 重複申請スキップ: ${member.user.tag}`);
            return;
          }

          if (!pendingRequests.has(vc.id)) pendingRequests.set(vc.id, new Map());
          pendingRequests.get(vc.id).set(member.id, true);

          await updateKnockNotifyMessage(vc, ownerId);

          console.log(`[Lock] 自動ノック: ${member.user.tag} → ${vc.name}`);
        } catch (err) { console.error("[Lock] エラー:", err.message); }
        return;
      }
    }

    if (oldState.channelId !== newState.channelId) {
      if (features.vcIntroDisplayEnabled) {
        const introDBPath = "./introDB.json";
        if (fs.existsSync(introDBPath)) {
          const db = JSON.parse(fs.readFileSync(introDBPath, "utf-8"));
          const data = db[member.id];
          if (data && data.content) {
            if (!introPosted.has(vc.id)) introPosted.set(vc.id, new Set());
            const postedSet = introPosted.get(vc.id);

            if (!postedSet.has(member.id)) {
              postedSet.add(member.id);

              const embed = new EmbedBuilder()
                .setColor(0x2b2d31)
                .setThumbnail(member.user.displayAvatarURL())
                .setDescription(
                  `## ${member.displayName}\n` +
                  `> ${data.content || "内容なし"}`
                )
                .setFooter({ text: "DIS COORDE Profile System", iconURL: client.user.displayAvatarURL() });

              try {
                const msg = await vc.send({ embeds: [embed] });
                introMsgIds.set(`${vc.id}_${member.id}`, msg.id);
              } catch (err) { }
            }
          }
        }
      }
    }
  }

  // ── 一時VCから退出したとき ────────────────────────────────────────────────
  if (oldState.channelId && tempChannels.has(oldState.channelId) && oldState.channelId !== newState.channelId) {
    const ch = oldState.channel;

    const key = `${oldState.channelId}_${oldState.member.id}`;
    if (introMsgIds.has(key)) {
      const msgId = introMsgIds.get(key);
      try {
        if (ch) {
          const msg = await ch.messages.fetch(msgId).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
      } catch (e) { }
      introMsgIds.delete(key);
      introPosted.get(oldState.channelId)?.delete(oldState.member.id);
    }

    if (!ch) return;

    if (ch.members.size === 0) {
      try {
        await ch.delete("全員退出のため自動削除");
        tempChannels.delete(oldState.channelId);
        profileMessageIds.delete(oldState.channelId);
        controlPanelMsgIds.delete(oldState.channelId);
        lockedVCs.delete(oldState.channelId);
        genderMode.delete(oldState.channelId);
        vcOwners.delete(oldState.channelId);
        pendingRequests.delete(oldState.channelId);
        allowedUsers.delete(oldState.channelId);
        knockNotifyMsgIds.delete(oldState.channelId);
        renameTimestamps.delete(oldState.channelId);
        introPosted.delete(oldState.channelId);
        limitLockedVCs.delete(oldState.channelId);
        console.log(`[DynamicVC] 削除: ${ch.name}`);
      } catch (err) { console.error("[DynamicVC] 削除エラー:", err.message); }
    } else {
      const currentOwnerId = vcOwners.get(ch.id);
      if (currentOwnerId === oldState.member.id) {
        const nextOwner = ch.members.first();
        if (nextOwner) {
          vcOwners.set(ch.id, nextOwner.id);
          console.log(`[DynamicVC] 部屋主退出のため、${nextOwner.user.tag} に権限を譲渡しました。 (${ch.name})`);
          await sendOrUpdateControlPanel(ch);
        }
      }
    }
  }
});

// ─── 自己紹介の変更（新規・編集・削除）を監視 ──────────────────────────────
const handleIntroUpdate = async (message, eventType = "create") => {
  const isDelete = eventType === "delete";
  if (message.partial && !isDelete) {
    try { await message.fetch(); } catch (e) { }
  }

  const checkChId = dynamicVC.introCheckChannelId || dynamicVC.introChannelId;
  const sourceChId = dynamicVC.introSourceChannelId || dynamicVC.introChannelId;

  if (message.channelId !== checkChId && message.channelId !== sourceChId) return;
  if (!message.guild) return;
  if (message.author?.bot) return;

  const introDBPath = "./introDB.json";
  let db = {};
  if (fs.existsSync(introDBPath)) db = JSON.parse(fs.readFileSync(introDBPath, "utf-8"));

  const userId = message.author?.id;
  if (!userId) {
    await syncIntrosOnly(message.guild);
    return;
  }

  const isCheckAction = (message.channelId === checkChId);
  const isSourceAction = (message.channelId === sourceChId);

  if (isDelete) {
    try {
      const msgs = await message.channel.messages.fetch({ limit: 50 });
      const userMsgs = msgs.filter(m => m.author.id === userId);

      if (userMsgs.size === 0) {
        if (db[userId]) {
          if (isSourceAction) delete db[userId].content;
          fs.writeFileSync(introDBPath, JSON.stringify(db, null, 2));
          console.log(`[Intro] 削除検知: ${userId} の自己紹介メッセージが全て削除されましたが、introducedフラグは維持します`);
        }
      } else {
        const latestMsg = userMsgs.first();
        let content = latestMsg.content || "";
        if (latestMsg.attachments.size > 0) content += "\n" + latestMsg.attachments.map(a => a.url).join("\n");

        if (!db[userId]) db[userId] = {};
        if (isCheckAction) db[userId].introduced = true;
        if (isSourceAction) db[userId].content = content.trim();
        fs.writeFileSync(introDBPath, JSON.stringify(db, null, 2));
        console.log(`[Intro] 削除検知: ${userId} の自己紹介を以前のものにロールバック`);
      }
    } catch (e) { }
  } else {
    let content = message.content || "";
    if (message.attachments.size > 0) content += "\n" + message.attachments.map(a => a.url).join("\n");
    content = content.trim();

    if (!db[userId]) db[userId] = {};
    if (isCheckAction) db[userId].introduced = true;
    if (isSourceAction) db[userId].content = content;

    fs.writeFileSync(introDBPath, JSON.stringify(db, null, 2));
    console.log(`[Intro] 個別更新: ${userId} の自己紹介を記録/更新`);

    if (eventType === "create" && isCheckAction) {
      if (db[userId].warnMsgId) {
        try {
          const checkChannel = message.guild.channels.cache.get(checkChId);
          if (checkChannel) {
            const warnMsg = await checkChannel.messages.fetch(db[userId].warnMsgId);
            if (warnMsg) await warnMsg.delete().catch(() => { });
          }
        } catch (e) { }
        delete db[userId].warnMsgId;
        fs.writeFileSync(introDBPath, JSON.stringify(db, null, 2));
      }

      // ★ 自己紹介キック機能がオフでも通知だけは送る（任意。不要なら features.introKickEnabled チェックを追加）
      try {
        let msgStr = messagesConfig["introNotify"] || "✅ <@{user}> さんの自己紹介を確認しました！";
        msgStr = msgStr.replace(/{user}/g, userId).replace(/\\n/g, '\n');
        const replyMsg = await message.reply({ content: msgStr });
        setTimeout(() => replyMsg.delete().catch(() => { }), 10000);
      } catch (e) { }
    }
  }
};

client.on(Events.MessageCreate, (msg) => handleIntroUpdate(msg, "create"));
client.on(Events.MessageUpdate, (oldMsg, newMsg) => handleIntroUpdate(newMsg, "update"));
client.on(Events.MessageDelete, (msg) => handleIntroUpdate(msg, "delete"));

// ─── 自己紹介履歴の同期のみ行う関数 ─────────────────────────────────────────
async function syncIntrosOnly(guild) {
  const checkChId = dynamicVC.introCheckChannelId || dynamicVC.introChannelId;
  const sourceChId = dynamicVC.introSourceChannelId || dynamicVC.introChannelId;
  const introChannel = guild.channels.cache.get(checkChId);
  const sourceChannel = guild.channels.cache.get(sourceChId);
  if (!introChannel && !sourceChannel) return;

  const introDBPath = "./introDB.json";
  let db = {};
  if (fs.existsSync(introDBPath)) db = JSON.parse(fs.readFileSync(introDBPath, "utf-8"));

  try {
    const currentAuthors = new Map();
    if (introChannel) {
      let lastId = null;
      let keepFetching = true;
      while (keepFetching) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;
        const messages = await introChannel.messages.fetch(options).catch(() => new Map());
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
          if (!msg.author.bot && !currentAuthors.has(msg.author.id)) {
            currentAuthors.set(msg.author.id, true);
          }
        }
        lastId = messages.last().id;
        if (messages.size < 100) keepFetching = false;
      }
    }

    const sourceContents = new Map();
    if (sourceChannel && sourceChannel.id !== introChannel?.id) {
      let lastSourceId = null;
      let keepFetchingSource = true;
      while (keepFetchingSource) {
        const options = { limit: 100 };
        if (lastSourceId) options.before = lastSourceId;
        const messages = await sourceChannel.messages.fetch(options).catch(() => new Map());
        if (messages.size === 0) break;
        for (const msg of messages.values()) {
          if (!msg.author.bot && !sourceContents.has(msg.author.id)) {
            let content = msg.content || "";
            if (msg.attachments.size > 0) content += "\n" + msg.attachments.map(a => a.url).join("\n");
            sourceContents.set(msg.author.id, content.trim());
          }
        }
        lastSourceId = messages.last().id;
        if (messages.size < 100) keepFetchingSource = false;
      }
    }

    for (const userId of Object.keys(db)) {
      if (introChannel) {
        if (currentAuthors.has(userId)) {
          db[userId].introduced = true;
        }
      }
      if (sourceChannel) {
        if (sourceChannel.id === introChannel?.id) {
          if (!currentAuthors.has(userId)) delete db[userId].content;
        } else {
          if (!sourceContents.has(userId)) delete db[userId].content;
        }
      }
    }

    fs.writeFileSync(introDBPath, JSON.stringify(db, null, 2));
    console.log("[Intro] 自己紹介履歴の同期が完了しました。");
  } catch (e) { console.error("[Intro] 同期エラー:", e.message); }
}

// ─── 自己紹介履歴の同期＆定期チェック ──────────────────────────────────────
async function syncAndCheckIntros(guild) {
  const introDBPath = "./introDB.json";
  const introChannelId = dynamicVC.introCheckChannelId || dynamicVC.introChannelId || "1496043493796221108";
  const introChannel = guild.channels.cache.get(introChannelId);
  if (!introChannel) return;

  await syncIntrosOnly(guild);

  setInterval(async () => {
    try {
      // ★ 機能がオフの場合は定期チェックをスキップ
      if (!features.introKickEnabled) return;

      let currentDB = JSON.parse(fs.readFileSync(introDBPath, "utf-8"));
      let updated = false;
      const members = await guild.members.fetch();
      const now = Date.now();

      const ONE_MINUTE = 60 * 1000;
      const warnThreshold = (dynamicVC.introWarnMinutes || 2880) * ONE_MINUTE;
      const kickThreshold = (dynamicVC.introKickMinutes || 4320) * ONE_MINUTE;

      for (const member of members.values()) {
        if (member.user.bot) continue;
        const data = currentDB[member.id] || {};
        if (data.introduced) continue;

        const joinedAt = member.joinedTimestamp;
        if (!joinedAt) continue;

        const elapsed = now - joinedAt;

        if (elapsed >= kickThreshold) {
          try {
            const msg = (messagesConfig["introKickDM"] || "サーバー参加後、指定された期間内に自己紹介の記入がなかったため、サーバーから自動退出となりました。").replace(/\\n/g, '\n');
            await member.send(msg);
          } catch { }
          await member.kick("自己紹介未記入");
          console.log(`[Intro] キック: ${member.user.tag}`);
          currentDB[member.id] = { introduced: false, kicked: true };
          updated = true;
        }
        else if (elapsed >= warnThreshold && !data.warned) {
          data.warned = true;
          updated = true;

          try {
            const leftMs = kickThreshold - elapsed;
            const leftMinutes = Math.floor(leftMs / 60000);

            let warnMsgStr = messagesConfig["introWarnMsg"] || "⚠️ <@{user}> さん、自己紹介の提出期限が迫っています。\\nあと **{leftMinutes}分** 以内にこのチャンネルに自己紹介を記入しないと、自動的に退出となりますのでご注意ください！";
            warnMsgStr = warnMsgStr.replace(/{user}/g, member.id).replace(/{leftMinutes}/g, leftMinutes).replace(/\\n/g, '\n');

            const warningMsg = await introChannel.send(warnMsgStr);
            data.warnMsgId = warningMsg.id;
            setTimeout(() => warningMsg.delete().catch(() => { }), Math.min(leftMs, 2147483647));
          } catch { }

          currentDB[member.id] = data;
        }
      }

      if (updated) fs.writeFileSync(introDBPath, JSON.stringify(currentDB, null, 2));
    } catch (e) { console.error("[IntroCron] エラー:", e.message); }
  }, 1000 * 60);
}

// ─── 起動時クリーンアップ & パネル設置 ──────────────────────────────────────
client.once(Events.ClientReady, async () => {
  global.__setupSettingsPanel = setupSettingsPanel; // /setup コマンドから呼べるよう登録
  setupSettingsPanel();
  if (!dynamicVC?.cleanupCategoryId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    syncAndCheckIntros(guild);

    const channels = await guild.channels.fetch();
    const empties = channels.filter(
      (c) =>
        c.type === ChannelType.GuildVoice &&
        c.parentId === dynamicVC.cleanupCategoryId &&
        c.id !== dynamicVC.triggerChannelId &&
        c.members.size === 0 &&
        c.name.includes("🔊")
    );
    for (const ch of empties.values()) {
      await ch.delete("起動時クリーンアップ");
      console.log(`[DynamicVC] 起動時クリーンアップ: ${ch.name}`);
    }
  } catch (err) { console.error("[DynamicVC] クリーンアップエラー:", err.message); }
});

client.login(token);
