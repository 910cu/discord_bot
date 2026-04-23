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
const features = Object.assign({ introKickEnabled: true, genderRoleEnabled: true, vcIntroDisplayEnabled: true }, featuresConfig || {});

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
// ロック(🔒) と 性別(♂️/♀️) のプレフィックスを一元管理する
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
  // 設定変更時の自動リネーム（プレフィックス追加）を行わない
  if (newBaseName === null) return true;

  if (newBaseName === vc.name) return true; // 変化なし

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
const SETTINGS_CHANNEL_ID = "1496141555705319445";

// featuresをconfig.jsonに保存するヘルパー
function saveFeatures() {
  const configPath = "./config.json";
  const fileData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  fileData.features = { ...features };
  fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2));
}

// パネルのバージョンと最終更新日時をconfig.jsonに保存して返す
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

async function setupSettingsPanel() {
  const channel = client.channels.cache.get(SETTINGS_CHANNEL_ID);
  if (!channel) return;

  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    const oldMsgs = msgs.filter((m) => m.author.id === client.user.id);
    for (const m of oldMsgs.values()) await m.delete().catch(() => { });
  } catch { }

  const on = "🟩";
  const off = "🟥";

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("⚙️ BOT 設定コントロールパネル")
    .setDescription(
      "-# 各機能の設定やON/OFFを下のボタンから変更できます。\n\n" +

      "### 🏗️ 基本設定\n" +
      "-# VCの作成・管理に必要なチャンネルとトリガーの設定です。\n" +
      `- 💤 **AFK（寝落ち移動先）** : ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}\n` +
      `- 🛠️ **VC作成パネル** : ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}\n` +
      `- ➕ **自由枠トリガー** : ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"}\n` +
      `- 👥 **4人部屋トリガー** : ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"}\n` +
      `- 👥 **5人部屋トリガー** : ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}\n\n` +

      `### 📝 自己紹介機能 ─ ${features.introKickEnabled ? on : off}\n` +
      "-# 参加後に自己紹介を書かないメンバーへの警告・自動キック機能です。\n" +
      `- 📝 **期限確認チャンネル** : ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n` +
      `-# 　↑ このチャンネルに書いた人を「自己紹介済み」として記録します。\n` +
      `- 📋 **VC表示用チャンネル** : ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}\n` +
      `-# 　↑ VCに入った時、このチャンネルの自己紹介文がVC内に自動表示されます。\n` +
      `- ⚠️ **警告タイミング** : 参加から \`${dynamicVC.introWarnMinutes ?? 2880}\` 分後\n` +
      `- 🚪 **キックタイミング** : 参加から \`${dynamicVC.introKickMinutes ?? 4320}\` 分後\n\n` +

      `### 🖼️ VC内自己紹介表示 ─ ${features.vcIntroDisplayEnabled ? on : off}\n` +
      "-# VCに入室した際、その人の自己紹介をVC内テキストに自動投稿する機能です。\n\n" +

      `### 🚻 VC性別制限機能 ─ ${features.genderRoleEnabled ? on : off}\n` +
      "-# VC部屋主が「♂️ 男性のみ」「♀️ 女性のみ」に設定できる機能です。\n" +
      "-# ロールが付いていないメンバーは入室時に自動でキックされます。\n" +
      `- ♂️ **男性ロール** : ${roles.male ? `<@&${roles.male}>` : "`未設定`"}\n` +
      `- ♀️ **女性ロール** : ${roles.female ? `<@&${roles.female}>` : "`未設定`"}`
    );

  // バージョンと最終更新日時をインクリメント・取得
  const meta = bumpPanelVersion();
  const updatedAt = new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  embed.setFooter({ text: `v${meta.version}  ·  最終更新: ${updatedAt} (JST)` });

  // 詳細設定ボタン
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cfg_btn_basic").setLabel("🏗️ 基本設定").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cfg_btn_intro").setLabel("📝 自己紹介機能").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cfg_btn_vc").setLabel("🚻 VC機能").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("config_messages").setLabel("💬 メッセージ").setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row1] });
}

// ─── サブパネル用ペイロード生成 ──────────────────────────────────────────────

function getIntroSettingsPayload() {
  const on = "🟩";
  const off = "🟥";

  const embed = new EmbedBuilder()
    .setTitle("📝 自己紹介機能 設定")
    .setDescription(
      `現在のステータス:\n` +
      `- 自動キック: ${features.introKickEnabled ? on : off}\n` +
      `- VC内表示: ${features.vcIntroDisplayEnabled ? on : off}\n\n` +
      `詳細設定:\n` +
      `- 📝 期限確認チャンネル: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n` +
      `- 📋 VC表示用チャンネル: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}\n` +
      `- ⚠️ 警告タイミング: ${dynamicVC.introWarnMinutes ? `\`${dynamicVC.introWarnMinutes}\` 分後` : "`2880` 分後 (2日)"}\n` +
      `- 🚪 キックタイミング: ${dynamicVC.introKickMinutes ? `\`${dynamicVC.introKickMinutes}\` 分後` : "`4320` 分後 (3日)"}`
    )
    .setColor(0x5865f2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle_intro_kick")
      .setLabel("自動キック")
      .setStyle(features.introKickEnabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("toggle_vc_intro")
      .setLabel("VC内表示")
      .setStyle(features.vcIntroDisplayEnabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("config_intro_time")
      .setLabel("⏱️ 期限タイミング設定")
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId("select_cfg_introcheck").setPlaceholder("📝 期限確認用チャンネルを選択").setChannelTypes([ChannelType.GuildText])
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId("select_cfg_introsource").setPlaceholder("📋 VC表示用チャンネルを選択").setChannelTypes([ChannelType.GuildText])
  );

  return { embeds: [embed], components: [row1, row2, row3], ephemeral: true };
}

function getVCSettingsPayload() {
  const on = "🟩";
  const off = "🟥";

  const embed = new EmbedBuilder()
    .setTitle("🎙️ VC機能 設定")
    .setDescription(
      `現在のステータス:\n` +
      `- 性別制限機能: ${features.genderRoleEnabled ? on : off}\n\n` +
      `詳細設定:\n` +
      `- ♂️ 男性ロール: ${roles.male ? `<@&${roles.male}>` : "`未設定`"}\n` +
      `- ♀️ 女性ロール: ${roles.female ? `<@&${roles.female}>` : "`未設定`"}`
    )
    .setColor(0x57f287);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("toggle_gender")
      .setLabel("性別制限")
      .setStyle(features.genderRoleEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId("select_cfg_male").setPlaceholder("♂️ 男性ロールを選択")
  );
  const row3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId("select_cfg_female").setPlaceholder("♀️ 女性ロールを選択")
  );

  return { embeds: [embed], components: [row1, row2, row3], ephemeral: true };
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
  const locked = lockedVCs.has(vc.id);
  const gender = genderMode.get(vc.id) ?? null;
  const userLimit = vc.userLimit ?? 0;
  const ownerId = vcOwners.get(vc.id);
  const isLimitLocked = limitLockedVCs.has(vc.id);

  const lockLine = locked ? "🔒 ロック中" : "🔓 開放中";
  const limitLine = userLimit === 0 ? "∞ 無制限" : `${userLimit}人`;
  const genderLine = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし";

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("🎛️ ルームコントロール")
    .setDescription(
      `**👑 部屋主:** <@${ownerId}>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `このパネルは**部屋主のみ**が操作できます。\n` +
      `━━━━━━━━━━━━━━━━━━━━`
    )
    .addFields(
      { name: "👥 人数上限", value: limitLine, inline: true },
    );

  // 人数固定VC（4人・5人部屋）: お布団ボタンのみ表示
  if (isLimitLocked) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("vc_afk_prompt").setLabel("🛏️ お布団へ運ぶ").setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row] };
  }

  embed
    .setColor(locked ? 0xe74c3c : 0x57f287)
    .setDescription(
      `**👑 部屋主:** <@${ownerId}>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `このパネルは**部屋主のみ**が操作できます。\n` +
      (locked ? `一番下の緑色のボタンは、**通話外の方**が参加を希望する際に使用します。\n` : "") +
      `━━━━━━━━━━━━━━━━━━━━`
    )
    .spliceFields(0, 1)
    .addFields(
      { name: "🔒 ルーム状態", value: lockLine, inline: true },
      { name: "👥 人数上限", value: limitLine, inline: true },
      { name: "🚻 性別制限", value: genderLine, inline: true },
    );

  // Row 1: 基本操作
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("label_basic").setLabel("【基本操作】").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("vc_rename").setLabel("✏️ 部屋名変更").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("vc_toggle_lock")
      .setLabel(locked ? "🔓 ロック解除" : "🔒 ロックする")
      .setStyle(locked ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("vc_afk_prompt").setLabel("🛏️ お布団へ運ぶ").setStyle(ButtonStyle.Secondary),
  );

  // Row 2: 人数上限
  const lStyle = (n) => userLimit === n ? ButtonStyle.Success : ButtonStyle.Secondary;
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("label_limit").setLabel("【人数制限】").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("vc_limit_0").setLabel("∞ 無制限").setStyle(lStyle(0)),
    new ButtonBuilder().setCustomId("vc_limit_4").setLabel("4人").setStyle(lStyle(4)),
    new ButtonBuilder().setCustomId("vc_limit_5").setLabel("5人").setStyle(lStyle(5)),
    new ButtonBuilder().setCustomId("vc_limit_custom").setLabel("指定...").setStyle(ButtonStyle.Primary),
  );

  // Row 3: 性別制限
  const gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary;
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("label_gender").setLabel("【性別制限】").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("vc_gender_none").setLabel("制限なし").setStyle(gStyle(null)),
    new ButtonBuilder().setCustomId("vc_gender_male").setLabel("♂️ 男性のみ").setStyle(gStyle("male")),
    new ButtonBuilder().setCustomId("vc_gender_female").setLabel("♀️ 女性のみ").setStyle(gStyle("female")),
  );

  const components = [row1, row2, row3];

  // ロック時のみノックボタンを表示
  if (locked) {
    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("label_knock").setLabel("【参加希望】").setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`vc_knock_${vc.id}`).setLabel("🚪 ノックして参加をリクエスト (通話外の方用)").setStyle(ButtonStyle.Success)
    );
    components.push(row4);
  }

  return { embeds: [embed], components };
}

// ─── コントロールパネルを初回送信（VC内テキストに投稿） ──────────────────────
async function sendOrUpdateControlPanel(vc) {
  // 既存パネルを削除
  const oldId = controlPanelMsgIds.get(vc.id);
  if (oldId) {
    try {
      const oldMsg = await vc.messages.fetch(oldId);
      await oldMsg.delete();
    } catch { /* 既に消えていれば無視 */ }
    controlPanelMsgIds.delete(vc.id);
  }
  // 新規送信
  try {
    const sent = await vc.send(buildPanelPayload(vc));
    controlPanelMsgIds.set(vc.id, sent.id);
  } catch (err) { console.error("[ControlPanel] 送信エラー:", err.message); }
}

// ─── ボタン操作時: interaction.update() でパネルをその場で書き換え ───────────
// sendOrUpdateControlPanel は使わず、押されたインタラクション自体を更新する
async function updatePanelViaInteraction(interaction, vc) {
  try {
    await interaction.update(buildPanelPayload(vc));
  } catch (e) {
    console.error("[ControlPanel] interaction.update失敗:", e.message);
    // fallback: 古いパネルを消して新規送信
    await sendOrUpdateControlPanel(vc);
  }
}

// ─── ノック通知メッセージを更新（インチャ内・1メッセージ使い回し） ──────────
async function updateKnockNotifyMessage(vc, ownerId) {
  const pending = pendingRequests.get(vc.id);
  const applicantIds = pending ? [...pending.keys()] : [];

  // pending が空なら通知メッセージを削除して終了
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

  // ボタンは1人につき1行（最大5人 = Discordのコンポーネント上限）
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
      const category = guild.channels.cache.get(categoryId);
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

  // ── ボタン：性別制限（男性のみ / 女性のみ / 制限なし）────────────────────
  if (interaction.isButton() && ["vc_gender_male", "vc_gender_female", "vc_gender_none"].includes(interaction.customId)) {
    const vc = interaction.member.voice.channel;
    if (!vc || !tempChannels.has(vc.id)) { await interaction.deferUpdate(); return; }
    if (vcOwners.get(vc.id) !== interaction.user.id) { await interaction.deferUpdate(); return; }

    const mode = interaction.customId === "vc_gender_male" ? "male"
      : interaction.customId === "vc_gender_female" ? "female"
        : null;

    // 同じ設定を再度押した場合は何もしない
    const currentMode = genderMode.get(vc.id) ?? null;
    if (mode === currentMode) { await interaction.deferUpdate(); return; }

    if (mode === null) { genderMode.delete(vc.id); } else { genderMode.set(vc.id, mode); }

    // パネルをインタラクションで即時更新（deferUpdateより先に呼ぶ）
    await updatePanelViaInteraction(interaction, vc);

    // 権限更新：性別ロールでViewChannel+Connectを制御
    // 方針: everyoneをdenyにして、対象ロールだけallowにする。
    //       ただし管理者権限はpermission_overwritesで上書きできないため、
    //       入室後のVoiceStateUpdateで弾く処理と組み合わせて使う。
    try {
      if (mode === null) {
        // 制限なし：カテゴリ継承に戻す（全上書きを削除）
        await vc.permissionOverwrites.set([
          { id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] },
        ]);
      } else {
        const allowId = mode === "male" ? roles.male : roles.female;
        const denyId = mode === "male" ? roles.female : roles.male;
        await vc.permissionOverwrites.set([
          // @everyone は ViewChannel・Connect を両方 deny
          { id: vc.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          // 対象性別ロール → 明示的に allow（これで @everyone の deny を上書き）
          { id: allowId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          // 対象外性別ロール → 念のため明示 deny（他ロールで allow されていても弾く）
          { id: denyId, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          // BOT自身は常に全権限を保持
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
    await interaction.deferUpdate();
    await vc.setUserLimit(limit);
    await sendOrUpdateControlPanel(vc);
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

  // ── ボタン：寝落ちした人をAFKへ移動（VC内のみ） ─────────────────────────
  if (interaction.isButton() && interaction.customId === "vc_afk_prompt") {
    const vc = interaction.member.voice.channel;

    // パネルのあるVCに現在参加しているかチェック
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

      // 3秒後に「あなただけに表示されています」のメッセージごと消去
      setTimeout(() => {
        interaction.deleteReply().catch(() => { });
      }, 3000);
    } catch (err) {
      console.error("[AFK] 移動エラー:", err.message);
      await interaction.update({ content: "⚠️ 移動に失敗しました。BOTの権限などを確認してください。", components: [] });
    }
    return;
  }

  // ── 設定パネルの期限設定ボタン（Modal表示） ──────────────────────────────────
  if (interaction.isButton() && interaction.customId === "config_intro_time") {
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

    await interaction.update({ content: `✅ **${updatedName}** を更新しました！`, embeds: [], components: [] });
    await setupSettingsPanel();
    return;
  }

  // ── 設定パネルの各ボタン（SelectMenu表示 -> Modal起動ボタン） ────────────────────────────────
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

  // ── 🏗️ 基本設定（AFK・VCパネル・トリガー） ────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_basic") {
    const row1 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("select_cfg_afk").setPlaceholder("💤 AFKチャンネルを選択").setChannelTypes([ChannelType.GuildVoice])
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("select_cfg_panel").setPlaceholder("🛠️ VCパネル設置チャンネルを選択").setChannelTypes([ChannelType.GuildText])
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger").setPlaceholder("➕ 自由枠トリガーVCを選択").setChannelTypes([ChannelType.GuildVoice])
    );
    const row4 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger4").setPlaceholder("👥 4人部屋トリガーVCを選択").setChannelTypes([ChannelType.GuildVoice])
    );
    const row5 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("select_cfg_trigger5").setPlaceholder("👥 5人部屋トリガーVCを選択").setChannelTypes([ChannelType.GuildVoice])
    );

    const embed = new EmbedBuilder()
      .setTitle("🏗️ 基本設定")
      .setDescription(
        `現在の設定:\n` +
        `- 💤 AFK: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}\n` +
        `- 🛠️ VCパネル: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}\n` +
        `- ➕ 自由枠トリガー: ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"}\n` +
        `- 👥 4人部屋トリガー: ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"}\n` +
        `- 👥 5人部屋トリガー: ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}`
      )
      .setColor(0x2b2d31);

    await interaction.reply({ embeds: [embed], components: [row1, row2, row3, row4, row5], ephemeral: true });
    setTimeout(() => interaction.deleteReply().catch(() => { }), 60000);
    return;
  }

  // ── 📝 自己紹介機能（チャンネル・期限） ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_intro") {
    const payload = getIntroSettingsPayload();
    await interaction.reply(payload);
    return;
  }


  // ── 🎙️ VC機能（性別ロール） ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "cfg_btn_vc") {
    const payload = getVCSettingsPayload();
    await interaction.reply(payload);
    return;
  }



  // ── ON/OFFトグル：自己紹介キック機能 ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "toggle_intro_kick") {
    features.introKickEnabled = !features.introKickEnabled;
    saveFeatures();
    await interaction.update(getIntroSettingsPayload());
    await setupSettingsPanel();
    return;
  }

  // ── ON/OFFトグル：VC内自己紹介表示 ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "toggle_vc_intro") {
    features.vcIntroDisplayEnabled = !features.vcIntroDisplayEnabled;
    saveFeatures();
    await interaction.update(getIntroSettingsPayload());
    await setupSettingsPanel();
    return;
  }

  // ── ON/OFFトグル：性別制限機能 ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "toggle_gender") {
    features.genderRoleEnabled = !features.genderRoleEnabled;
    saveFeatures();
    await interaction.update(getVCSettingsPayload());
    await setupSettingsPanel();
    return;
  }


  // ── セレクトメニューの選択処理 ────────────────────────────────────────────

  if (interaction.isAnySelectMenu() && interaction.customId.startsWith("select_cfg_")) {
    const field = interaction.customId.replace("select_cfg_", "");
    const selectedId = interaction.values[0];

    const configPath = "./config.json";
    const fileData = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    let updatedName = "";
    if (field === "trigger") { fileData.dynamicVC.triggerChannelId = selectedId; dynamicVC.triggerChannelId = selectedId; updatedName = "自由枠トリガーVC"; }
    else if (field === "trigger4") { fileData.dynamicVC.triggerChannelId4 = selectedId; dynamicVC.triggerChannelId4 = selectedId; updatedName = "4人部屋トリガーVC"; }
    else if (field === "trigger5") { fileData.dynamicVC.triggerChannelId5 = selectedId; dynamicVC.triggerChannelId5 = selectedId; updatedName = "5人部屋トリガーVC"; }
    else if (field === "afk") { fileData.dynamicVC.afkChannelId = selectedId; dynamicVC.afkChannelId = selectedId; updatedName = "AFKチャンネル"; }
    else if (field === "panel") { fileData.dynamicVC.createPanelChannelId = selectedId; dynamicVC.createPanelChannelId = selectedId; updatedName = "パネル設置チャンネル"; }
    else if (field === "introcheck") { fileData.dynamicVC.introCheckChannelId = selectedId; dynamicVC.introCheckChannelId = selectedId; updatedName = "自己紹介(期限確認)チャンネル"; }
    else if (field === "introsource") { fileData.dynamicVC.introSourceChannelId = selectedId; dynamicVC.introSourceChannelId = selectedId; updatedName = "自己紹介(VC表示用)チャンネル"; }
    else if (field === "male") { fileData.roles.male = selectedId; roles.male = selectedId; updatedName = "男性ロール"; }
    else if (field === "female") { fileData.roles.female = selectedId; roles.female = selectedId; updatedName = "女性ロール"; }

    fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2));

    const isRole = field === "male" || field === "female";
    const mention = isRole ? `<@&${selectedId}>` : `<#${selectedId}>`;

    await interaction.update({ content: `✅ **${updatedName}** を ${mention} に更新しました！\n（続けて他の項目を変更したい場合は、もう一度パネルの設定ボタンを押してください）`, embeds: [], components: [] });
    setTimeout(() => interaction.deleteReply().catch(() => { }), 15000);
    await setupSettingsPanel();
    if (field === "panel") {
      await setupCreatePanel();
    }
    return;
  }

  // ── ボタン：通話外からのノック申請 ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("vc_knock_")) {
    const vcId = interaction.customId.replace("vc_knock_", "");
    const vc = interaction.guild.channels.cache.get(vcId);
    if (!vc || !tempChannels.has(vcId)) { await interaction.deferUpdate(); return; }

    const member = interaction.member;
    const ownerId = vcOwners.get(vcId);

    // 既にVCにいるなら弾く
    if (member.voice.channelId === vcId) {
      await interaction.reply({ content: "あなたは既にこの通話に参加しています。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    // 部屋主なら弾く
    if (ownerId === member.id) {
      await interaction.reply({ content: "部屋主はノックできません。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    // ロックされていなければそのまま入れる
    if (!lockedVCs.has(vcId)) {
      await interaction.reply({ content: "この部屋は現在ロックされていないため、そのまま入室できます。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    // 重複申請チェック
    if (pendingRequests.get(vcId)?.has(member.id)) {
      await interaction.reply({ content: "既にノック申請を送信済みです。部屋主の応答をお待ちください。", ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => { }), 5000);
      return;
    }

    // pendingに登録
    if (!pendingRequests.has(vcId)) pendingRequests.set(vcId, new Map());
    pendingRequests.get(vcId).set(member.id, true);

    // 通知メッセージを更新
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

      // 許可済みリストに追加
      if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set());
      allowedUsers.get(vcId).add(applicantId);

      // pendingから削除してノック通知を更新
      pendingRequests.get(vcId)?.delete(applicantId);
      await updateKnockNotifyMessage(vc, interaction.user.id);

      // すでにVCにいる場合は自動で移動、そうでなければインチャに通知（60秒後自動削除）
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
        // VCにいない場合はインチャに通知
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

      // pendingから削除してノック通知を更新
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

    // ── 性別制限チェック（部屋主は除外）────────────────────────────────────
    const gender = genderMode.get(vc.id) ?? null;
    if (features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== member.id) {
      const requiredRoleId = gender === "male" ? roles.male : roles.female;
      if (!member.roles.cache.has(requiredRoleId)) {
        try {
          await member.voice.disconnect();
          // DMで理由を通知（失敗しても無視）
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

    // ロック中かつ部屋主以外 → 許可済みでなければキック＆即時通知
    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== member.id) {
      // 許可済みユーザーはそのまま入室させる（自己紹介表示ロジックへfall through）
      if (allowedUsers.get(vc.id)?.has(member.id)) {
        allowedUsers.get(vc.id).delete(member.id);
        // fall through → 以下の自己紹介表示ロジックへ続く
      } else {
        try {
          const ownerId = vcOwners.get(vc.id);
          await member.voice.disconnect();

          // 重複申請チェック（既に申請中なら通知しない）
          if (pendingRequests.get(vc.id)?.has(member.id)) {
            console.log(`[Lock] 重複申請スキップ: ${member.user.tag}`);
            return;
          }

          // pending に登録
          if (!pendingRequests.has(vc.id)) pendingRequests.set(vc.id, new Map());
          pendingRequests.get(vc.id).set(member.id, true);

          // インチャのノック通知メッセージを更新（1つのメッセージを使い回す）
          await updateKnockNotifyMessage(vc, ownerId);

          console.log(`[Lock] 自動ノック: ${member.user.tag} → ${vc.name}`);
        } catch (err) { console.error("[Lock] エラー:", err.message); }
        return;
      }
    }

    // ロックなし・または入室許可済み → 通常入室（プロフィール等表示）
    if (oldState.channelId !== newState.channelId) {
      if (features.vcIntroDisplayEnabled) {  // VC内自己紹介表示機能が有効な時のみ実行
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
                .setAuthor({ name: `${member.displayName} さんの自己紹介`, iconURL: member.user.displayAvatarURL() })
                .setDescription(data.content || "内容なし")
                .setColor(0x5865f2);

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

    // 退室したユーザーの自己紹介メッセージをインチャから削除する
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
      // 再入室時に再度表示するため postedSet からも削除
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
      // 部屋主が退出した場合は、残っている他の人に権限を譲渡する
      const currentOwnerId = vcOwners.get(ch.id);
      if (currentOwnerId === oldState.member.id) {
        const nextOwner = ch.members.first(); // 残っているメンバーを取得
        if (nextOwner) {
          vcOwners.set(ch.id, nextOwner.id);
          console.log(`[DynamicVC] 部屋主退出のため、${nextOwner.user.tag} に権限を譲渡しました。 (${ch.name})`);
          // パネルを更新して新しい部屋主の名前を表示
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
  // もし partial で author が取れない場合（削除時など）は、確実を期すため全体同期にフォールバック
  if (!userId) {
    await syncIntrosOnly(message.guild);
    return;
  }

  // もしチェックチャンネルとソースチャンネルが同じなら1回の処理で両方更新する
  const isCheckAction = (message.channelId === checkChId);
  const isSourceAction = (message.channelId === sourceChId);

  if (isDelete) {
    try {
      const msgs = await message.channel.messages.fetch({ limit: 50 });
      const userMsgs = msgs.filter(m => m.author.id === userId);

      if (userMsgs.size === 0) {
        if (db[userId]) {
          // 書いた後に消した場合はキックしないようにするため introduced を false に戻さない
          // if (isCheckAction) db[userId].introduced = false; 
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

    // DB更新
    for (const userId of Object.keys(db)) {
      if (introChannel) {
        if (currentAuthors.has(userId)) {
          db[userId].introduced = true;
        }
        // メッセージが無くても、一度 true になったなら戻さない
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

  // 1. 同期処理
  await syncIntrosOnly(guild);

  // 2. 定期チェック（1分ごと）
  setInterval(async () => {
    try {
      let currentDB = JSON.parse(fs.readFileSync(introDBPath, "utf-8"));
      let updated = false;
      const members = await guild.members.fetch();
      const now = Date.now();

      // 設定値からミリ秒を計算
      const ONE_MINUTE = 60 * 1000;
      const warnThreshold = (dynamicVC.introWarnMinutes || 2880) * ONE_MINUTE;
      const kickThreshold = (dynamicVC.introKickMinutes || 4320) * ONE_MINUTE;

      for (const member of members.values()) {
        if (member.user.bot) continue;
        if (!features.introKickEnabled) continue;  // 自己紹介キック機能がオフの場合はスキップ
        const data = currentDB[member.id] || {};
        if (data.introduced) continue;

        const joinedAt = member.joinedTimestamp;
        if (!joinedAt) continue;

        const elapsed = now - joinedAt;

        // キック判定
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
        // 警告メンション判定
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
            // 警告メッセージが残らないように自動削除 (上限 24.8日)
            setTimeout(() => warningMsg.delete().catch(() => { }), Math.min(leftMs, 2147483647));
          } catch { }

          currentDB[member.id] = data;
        }
      }

      if (updated) fs.writeFileSync(introDBPath, JSON.stringify(currentDB, null, 2));
    } catch (e) { console.error("[IntroCron] エラー:", e.message); }
  }, 1000 * 60); // 1分ごと
}

// ─── 起動時クリーンアップ & パネル設置 ──────────────────────────────────────
client.once(Events.ClientReady, async () => {
  setupSettingsPanel(); // 設定パネルを配置
  if (!dynamicVC?.cleanupCategoryId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    syncAndCheckIntros(guild); // 自己紹介履歴の同期＆監視開始

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
