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

// ─── 設定管理 ────────────────────────────────────────────────────────
function saveConfig(updateFn) {
  const data = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  updateFn(data);
  fs.writeFileSync("./config.json", JSON.stringify(data, null, 2));
}

function bumpPanelVersion() {
  let meta;
  saveConfig(d => {
    meta = d.meta = d.meta || { version: 0 };
    meta.version++;
    meta.lastUpdated = new Date().toISOString();
  });
  return meta;
}

const getInfo = () => {
  const f = features, d = dynamicVC, r = roles;
  return [
    { key: "afkEnabled", h: "💤 AFK設定", d: `AFK: ${d.afkChannelId ? `<#${d.afkChannelId}>` : "未設定"}`, btn: "cfg_btn_afk", label: "💤 AFK設定", sId: "select_cfg_afk", sP: "移動先を選択", sT: [ChannelType.GuildVoice] },
    { key: "vcPanelEnabled", h: "🛠️ パネル設定", d: `設置先: ${d.createPanelChannelId ? `<#${d.createPanelChannelId}>` : "未設定"}`, btn: "cfg_btn_panel", label: "🛠️ パネル設定", sId: "select_cfg_panel", sP: "設置先を選択", sT: [ChannelType.GuildText] },
    {
      key: "vcCreationEnabled", h: "➕ VC自動作成", d: `自由: ${d.triggerChannelId ? `<#${d.triggerChannelId}>` : "未設定"}\n> 4/5人: ${d.triggerChannelId4 ? `<#${d.triggerChannelId4}>` : "未設定"} / ${d.triggerChannelId5 ? `<#${d.triggerChannelId5}>` : "未設定"}`, btn: "cfg_btn_trigger", label: "➕ VC自動作成", items: [
        { id: "select_cfg_trigger", p: "自由枠を選択" }, { id: "select_cfg_trigger4", p: "4人部屋を選択" }, { id: "select_cfg_trigger5", p: "5人部屋を選択" }
      ]
    },
    { key: "introKickEnabled", h: "📝 未提出者自動整理", d: `確認: ${d.introCheckChannelId ? `<#${d.introCheckChannelId}>` : "未設定"}\n> 警告/実行: ${d.introWarnMinutes}分 / ${d.introKickMinutes}分`, btn: "cfg_btn_intro_kick", label: "📝 未提出者整理", sId: "select_cfg_introcheck", sP: "確認先を選択", sT: [ChannelType.GuildText], extraBtn: { id: "config_intro_time", l: "⏱️ 期限設定" } },
    { key: "vcIntroDisplayEnabled", h: "🖼️ VC内表示設定", d: `ソース: ${d.introSourceChannelId ? `<#${d.introSourceChannelId}>` : "未設定"}`, btn: "cfg_btn_intro_display", label: "🖼️ VC内自己紹介表示", sId: "select_cfg_introsource", sP: "ソースを選択", sT: [ChannelType.GuildText] },
    { key: "genderRoleEnabled", h: "🎙️ 部屋制限設定", d: `♂️ ${r.male ? `<@&${r.male}>` : "未設定"} / ♀️ ${r.female ? `<@&${r.female}>` : "未設定"}`, btn: "cfg_btn_vc", label: "🚻 部屋制限設定", roles: [{ id: "select_cfg_male", p: "♂️ 男性を選択" }, { id: "select_cfg_female", p: "♀️ 女性を選択" }] }
  ];
};

async function setupSettingsPanel(overrideId) {
  if (overrideId) saveConfig(d => d.settingsChannelId = overrideId);
  const channel = client.channels.cache.get(require("./config.json").settingsChannelId);
  if (!channel) return;
  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
  } catch { }

  const meta = bumpPanelVersion(), updated = new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  let desc = `-# Version ${meta.version}.0.0 ｜ System: Operational\n\n`;
  getInfo().forEach(i => { if (features[i.key]) desc += `### ${i.h}\n> ${i.d}\n\n`; });

  const rows = [], info = getInfo();
  for (let i = 0; i < info.length; i += 3) rows.push(createRow(...info.slice(i, i + 3).map(x => createBtn(x.btn, x.label))));
  rows.push(createRow(createBtn("config_messages", "💬 メッセージ設定")));

  const embed = createEmbed(desc).setTitle("⬛ DIS COORDE | Control Panel").setFooter({ text: `Last Updated: ${updated} (JST)` });
  await channel.send({ embeds: [embed], components: rows });
}

function getSubPanel(key) {
  const i = getInfo().find(x => x.btn === key || x.key === key);
  const en = features[i.key];
  const rows = [createRow(createBtn(`toggle_${i.key}`, `${i.label.split(" ")[1]}: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger), i.extraBtn ? createBtn(i.extraBtn.id, i.extraBtn.l, ButtonStyle.Primary, !en) : null).removeComponents(null)];

  if (i.items) i.items.forEach(item => rows.push(createRow(new ChannelSelectMenuBuilder().setCustomId(item.id).setPlaceholder(en ? item.p : "⛔ 無効").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!en))));
  else if (i.sId) rows.push(createRow(new ChannelSelectMenuBuilder().setCustomId(i.sId).setPlaceholder(en ? i.sP : "⛔ 無効").setChannelTypes(i.sT).setDisabled(!en)));
  else if (i.roles) i.roles.forEach(r => rows.push(createRow(new RoleSelectMenuBuilder().setCustomId(r.id).setPlaceholder(en ? r.p : "⛔ 無効").setDisabled(!en))));

  rows.push(createRow(createBtn("cfg_back_main", "⬅️ 戻る")));
  return { embeds: [createEmbed(`ステータス: ${en ? "🟩" : "🟥"}\n${i.d}`, 0x2b2d31, i.h)], components: rows, ephemeral: true };
}

function getMainSettingsPayload() {
  let desc = "";
  getInfo().forEach(i => { if (features[i.key]) desc += `### ${i.h}\n> ${i.d}\n\n`; });
  const rows = [], info = getInfo();
  for (let i = 0; i < info.length; i += 3) rows.push(createRow(...info.slice(i, i + 3).map(x => createBtn(x.btn, x.label))));
  rows.push(createRow(createBtn("config_messages", "💬 メッセージ設定")));
  return { embeds: [createEmbed(desc || "（有効な機能がありません）", 0x2b2d31, "⬛ DIS COORDE | Control Panel")], components: rows, ephemeral: true };
}
function getVCSettingsPayload() {
  const en = features.genderRoleEnabled;
  const desc = `ステータス: ${en ? "🟩" : "🟥"}\n♂️ ${roles.male ? `<@&${roles.male}>` : "未設定"} / ♀️ ${roles.female ? `<@&${roles.female}>` : "未設定"}`;
  const rows = [
    createRow(createBtn("toggle_gender", `部屋制限: ${en ? "有効" : "無効"}`, en ? ButtonStyle.Success : ButtonStyle.Danger)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_male").setPlaceholder(en ? "♂️ 男性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(new RoleSelectMenuBuilder().setCustomId("select_cfg_female").setPlaceholder(en ? "♀️ 女性を選択" : "⛔ 無効").setDisabled(!en)),
    createRow(createBtn("cfg_back_main", "⬅️ 戻る"))
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
  function buildPanelPayload(vc) {
    const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id), ownerId = vcOwners.get(vc.id), isLimitLocked = limitLockedVCs.has(vc.id);
    const gl = gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 制限なし", ll = (vc.userLimit || 0) === 0 ? "∞ 無制限" : `${vc.userLimit}人`;
    const desc = `### 👑 部屋主 [Owner]\n> <@${ownerId}>\n\n▼ **設定状況 [Status]**\n> 状態 ─ ${locked ? "🔴 **LOCKED**" : "🟢 **OPEN**"}\n> 上限 ─ \`${ll}\`\n> 制限 ─ \`${gl}\`\n\n-# 🛡️ 制限・名前変更は部屋主のみ可\n-# 🛏️ お布団は誰でも可`;
    const rows = [createRow(createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !features.afkEnabled))];
    if (!isLimitLocked) rows.unshift(createRow(createBtn("vc_rename", "✏️ 部屋名変更"), createBtn("vc_toggle_lock", locked ? "🔓 ロック解除" : "🔒 ロックする", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 部屋制限", ButtonStyle.Secondary, !features.genderRoleEnabled)));
    if (locked) rows.push(createRow(createBtn(`vc_knock_${vc.id}`, "🚪 ノックして参加をリクエスト", ButtonStyle.Success)));
    return { embeds: [createEmbed(desc, locked ? 0xe74c3c : 0x57f287)], components: rows };
  }

  function buildVCSettingsPayload(vc) {
    const gender = genderMode.get(vc.id), limit = vc.userLimit || 0, gStyle = m => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = n => limit === n ? ButtonStyle.Success : ButtonStyle.Secondary;
    const desc = `現在の設定状況:\n> 人数制限 ─ ${limit || "∞"}人\n> 性別制限 ─ ${gender || "なし"}\n\n下のボタンで設定を変更できます。`;
    return {
      embeds: [createEmbed(desc, 0x2b2d31, `🛡️ 部屋制限設定 | ${vc.name}`)], components: [
        createRow(createBtn("label_g", "【性別】", ButtonStyle.Secondary, true), createBtn("vc_gender_none", "なし", gStyle(null)), createBtn("vc_gender_male", "♂️ 男性", gStyle("male")), createBtn("vc_gender_female", "♀️ 女性", gStyle("female"))),
        createRow(createBtn("label_l", "【人数】", ButtonStyle.Secondary, true), createBtn("vc_limit_0", "∞ 無制限", lStyle(0)), createBtn("vc_limit_4", "4人", lStyle(4)), createBtn("vc_limit_5", "5人", lStyle(5)), createBtn("vc_limit_custom", "指定...", ButtonStyle.Primary)),
        createRow(createBtn("vc_main_panel", "⬅️ 戻る"))
      ]
    };
  }

  async function sendOrUpdateControlPanel(vc) {
    const oldId = controlPanelMsgIds.get(vc.id), payload = buildPanelPayload(vc);
    try {
      if (oldId) await (await vc.messages.fetch(oldId)).edit(payload);
      else controlPanelMsgIds.set(vc.id, (await vc.send(payload)).id);
    } catch { if (!oldId) controlPanelMsgIds.set(vc.id, (await vc.send(payload)).id); }
  }

  async function updatePanelViaInteraction(int, vc) { try { await int.update(buildPanelPayload(vc)); } catch { await sendOrUpdateControlPanel(vc); } }

  async function updateKnockNotifyMessage(vc, ownerId) {
    const p = pendingRequests.get(vc.id), ids = p ? [...p.keys()] : [];
    if (!ids.length) { try { const mid = knockNotifyMsgIds.get(vc.id); if (mid) await (await vc.messages.fetch(mid)).delete(); } catch { } return knockNotifyMsgIds.delete(vc.id); }
    const embeds = [createEmbed("", 0xf39c12, "🚪 ノックされています").setTimestamp(), ...ids.map(uid => createEmbed(`<@${uid}> が入室しようとしています。`, 0xf39c12).setThumbnail(vc.guild.members.cache.get(uid)?.user.displayAvatarURL() || null))];
    const rows = ids.slice(0, 5).map(uid => createRow(createBtn(`knock_approve_${vc.id}_${uid}`, "✅ 許可", ButtonStyle.Success), createBtn(`knock_deny_${vc.id}_${uid}`, "❌ 拒否", ButtonStyle.Danger)));
    try { const mid = knockNotifyMsgIds.get(vc.id); if (mid) await (await vc.messages.fetch(mid)).edit({ embeds, components: rows }); else knockNotifyMsgIds.set(vc.id, (await vc.send({ embeds, components: rows })).id); } catch { knockNotifyMsgIds.set(vc.id, (await vc.send({ embeds, components: rows })).id); }
  }

  const silentReply = async (int) => { try { await int.reply("\u200B"); await int.deleteReply(); } catch { } };

  client.once(Events.ClientReady, async (c) => { console.log(`🤖 ${c.user.tag} 起動`); await deployCommands(); await setupCreatePanel(); });

  client.on(Events.InteractionCreate, async (int) => {
    const { customId: cid, user, member, guild, fields } = int;
    const vc = member?.voice?.channel, isOwner = vc && vcOwners.get(vc.id) === user.id;

    if (int.isChatInputCommand()) return client.commands.get(int.commandName)?.execute(int).catch(e => console.error(e));

    if (int.isButton()) {
      if (cid === "cfg_back_main") return int.update(getMainSettingsPayload());
      if (cid.startsWith("cfg_btn_")) return int.update(getSubPanel(cid));
      if (cid.startsWith("toggle_")) {
        const k = cid.replace("toggle_", ""); features[k] = !features[k];
        saveConfig(d => d.features = features);
        if (k === "genderRoleEnabled" && !features[k]) {
          for (const id of tempChannels) {
            const c = guild.channels.cache.get(id);
            if (c && genderMode.has(id)) { genderMode.delete(id); await c.permissionOverwrites.set([{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }]); sendOrUpdateControlPanel(c); }
          }
        }
        await int.update(getSubPanel(k)); return setupSettingsPanel();
      }
      if (cid.startsWith("create_vc_")) {
        if (!features.vcPanelEnabled) return int.reply({ content: "⛔ 無効", ephemeral: true });
        const m = new ModalBuilder().setCustomId(cid === "create_vc_panel" ? "create_vc_modal" : cid === "create_vc_4" ? "create_vc_modal_4" : "create_vc_modal_5").setTitle("🎙️ VC作成");
        m.addComponents(createRow(new TextInputBuilder().setCustomId("name").setLabel("部屋名").setStyle(TextInputStyle.Short).setValue(cid.includes("4") ? "雑談4人部屋" : cid.includes("5") ? "雑談5人部屋" : `${member.displayName}のVC`).setRequired(true)));
        return int.showModal(m);
      }
      if (cid === "vc_toggle_lock" && isOwner) { lockedVCs.has(vc.id) ? lockedVCs.delete(vc.id) : lockedVCs.add(vc.id); await updatePanelViaInteraction(int, vc); return updateVcName(vc, null, int); }
      if (cid === "vc_settings_btn" && isOwner && features.genderRoleEnabled) return int.update(buildVCSettingsPayload(vc));
      if (cid === "vc_main_panel" && isOwner) return int.update(buildPanelPayload(vc));
      if (["vc_gender_male", "vc_gender_female", "vc_gender_none"].includes(cid) && isOwner && features.genderRoleEnabled) {
        const mode = cid === "vc_gender_none" ? null : cid.split("_")[2]; mode ? genderMode.set(vc.id, mode) : genderMode.delete(vc.id);
        await int.update(buildVCSettingsPayload(vc));
        const allow = mode === "male" ? roles.male : roles.female, deny = mode === "male" ? roles.female : roles.male;
        await vc.permissionOverwrites.set(mode ? [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: allow, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: deny, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] : [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }]);
        return updateVcName(vc, null, int);
      }
      if (cid.startsWith("vc_limit_") && cid !== "vc_limit_custom" && isOwner) {
        if (limitLockedVCs.has(vc.id)) return int.reply({ content: messagesConfig.limitLockedWarning, ephemeral: true });
        await vc.setUserLimit(parseInt(cid.split("_")[2])); return int.update(buildVCSettingsPayload(vc));
      }
      if (cid === "vc_limit_custom" && isOwner) {
        if (limitLockedVCs.has(vc.id)) return int.reply({ content: messagesConfig.limitLockedWarning, ephemeral: true });
        const m = new ModalBuilder().setCustomId(`limit_modal_${vc.id}`).setTitle("🔢 人数上限");
        m.addComponents(createRow(new TextInputBuilder().setCustomId("limit").setLabel("人数 (0-99)").setStyle(TextInputStyle.Short).setRequired(true)));
        return int.showModal(m);
      }
      if (cid === "vc_rename" && isOwner) {
        const m = new ModalBuilder().setCustomId(`rename_modal_${vc.id}`).setTitle("📝 部屋名変更");
        m.addComponents(createRow(new TextInputBuilder().setCustomId("name").setLabel("新しい名前").setStyle(TextInputStyle.Short).setRequired(true)));
        return int.showModal(m);
      }
      if (cid === "vc_afk_prompt") {
        if (!features.afkEnabled) return int.reply({ content: "⛔ 無効", ephemeral: true });
        if (!vc || vc.id !== int.channelId) return int.reply({ content: "⚠️ VC参加中のみ可", ephemeral: true });
        return int.reply({ content: "💤 移動させるユーザーを選択", components: [createRow(new UserSelectMenuBuilder().setCustomId(`vc_afk_select_${vc.id}`).setPlaceholder("選択"))], ephemeral: true });
      }
      if (cid === "config_intro_time" && features.introKickEnabled) {
        const m = new ModalBuilder().setCustomId("config_intro_modal").setTitle("⏱️ 期限設定");
        m.addComponents(createRow(new TextInputBuilder().setCustomId("w").setLabel("警告(分)").setStyle(TextInputStyle.Short).setValue(String(dynamicVC.introWarnMinutes))), createRow(new TextInputBuilder().setCustomId("k").setLabel("キック(分)").setStyle(TextInputStyle.Short).setValue(String(dynamicVC.introKickMinutes))));
        return int.showModal(m);
      }
      if (cid === "config_messages") return int.reply({ content: "📝 **メッセージ設定**", components: [createRow(createBtn("modal_msg_intro", "📝 自己紹介関連", ButtonStyle.Primary), createBtn("modal_msg_vc", "🎙️ VC関連", ButtonStyle.Primary))], ephemeral: true });
      if (cid.startsWith("modal_msg_")) {
        const isI = cid.includes("intro"), m = new ModalBuilder().setCustomId(isI ? "submit_msg_intro" : "submit_msg_vc").setTitle("📝 メッセージ編集");
        const keys = isI ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];
        m.addComponents(keys.map(k => createRow(new TextInputBuilder().setCustomId(`input_${k}`).setLabel(k).setStyle(TextInputStyle.Paragraph).setValue(messagesConfig[k].replace(/\\n/g, "\n")))));
        return int.showModal(m);
      }
      if (cid.startsWith("vc_knock_")) {
        const vid = cid.replace("vc_knock_", ""), c = guild.channels.cache.get(vid);
        if (!c || member.voice.channelId === vid || vcOwners.get(vid) === user.id || !lockedVCs.has(vid)) return int.reply({ content: "❌ 申請不要/不可", ephemeral: true });
        if (!pendingRequests.has(vid)) pendingRequests.set(vid, new Map());
        if (pendingRequests.get(vid).has(user.id)) return int.reply({ content: "申請済み", ephemeral: true });
        pendingRequests.get(vid).set(user.id, true); await updateKnockNotifyMessage(c, vcOwners.get(vid)); return int.reply({ content: "✅ 申請完了", ephemeral: true });
      }
      if (cid.startsWith("knock_approve_") || cid.startsWith("knock_deny_")) {
        const [, , vid, aid] = cid.split("_"); if (vcOwners.get(vid) !== user.id) return int.deferUpdate();
        await int.deferUpdate(); pendingRequests.get(vid)?.delete(aid);
        if (cid.includes("approve")) {
          if (!allowedUsers.has(vid)) allowedUsers.set(vid, new Set());
          allowedUsers.get(vid).add(aid); const app = await guild.members.fetch(aid);
          if (app.voice.channel) await app.voice.setChannel(vid).catch(() => { });
          else (await guild.channels.cache.get(vid).send(`✅ <@${aid}> さんの参加が許可されました！`)).delete().catch(() => { });
        }
        return updateKnockNotifyMessage(guild.channels.cache.get(vid), user.id);
      }
      if (cid.startsWith("bio_input_") && cid.includes(user.id)) {
        const m = new ModalBuilder().setCustomId(`bio_modal_${user.id}`).setTitle("📝 自己紹介入力");
        m.addComponents(createRow(new TextInputBuilder().setCustomId("text").setLabel("自己紹介").setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false)));
        return int.showModal(m);
      }
    }

    if (int.isModalSubmit()) {
      await silentReply(int);
      if (cid.startsWith("create_vc_modal")) {
        const limit = cid.endsWith("4") ? 4 : cid.endsWith("5") ? 5 : dynamicVC.userLimit || 0;
        const ch = await guild.channels.create({ name: fields.getTextInputValue("name"), type: ChannelType.GuildVoice, parent: dynamicVC.cleanupCategoryId, userLimit: limit, permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] });
        tempChannels.add(ch.id); vcOwners.set(ch.id, user.id); if (limit) limitLockedVCs.add(ch.id); return sendOrUpdateControlPanel(ch);
      }
      if (cid.startsWith("limit_modal_")) { const c = guild.channels.cache.get(cid.replace("limit_modal_", "")), l = parseInt(fields.getTextInputValue("limit")); if (c && !isNaN(l)) { await c.setUserLimit(l); sendOrUpdateControlPanel(c); } }
      if (cid.startsWith("rename_modal_")) { const c = guild.channels.cache.get(cid.replace("rename_modal_", "")); if (c) updateVcName(c, fields.getTextInputValue("name").replace(/^(?:🔒|♂️|♀️)+/, "").trim(), int); }
      if (cid === "config_intro_modal") {
        const w = parseInt(fields.getTextInputValue("w")), k = parseInt(fields.getTextInputValue("k"));
        if (!isNaN(w) && !isNaN(k)) { dynamicVC.introWarnMinutes = w; dynamicVC.introKickMinutes = k; saveConfig(d => { d.dynamicVC.introWarnMinutes = w; d.dynamicVC.introKickMinutes = k; }); setupSettingsPanel(); }
      }
      if (cid.startsWith("submit_msg_")) {
        const keys = cid.includes("intro") ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];
        keys.forEach(k => messagesConfig[k] = fields.getTextInputValue(`input_${k}`).replace(/\n/g, "\\n")); fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));
      }
      if (cid.startsWith("bio_modal_")) { const b = fields.getTextInputValue("text").trim(); b ? memberBios.set(user.id, b) : memberBios.delete(user.id); if (vc && tempChannels.has(vc.id)) updateProfileMessage(vc); }
    }

    if (int.isAnySelectMenu() && cid.startsWith("select_cfg_")) {
      const f = cid.replace("select_cfg_", ""), val = int.values[0], map = { trigger: ["dynamicVC", "triggerChannelId"], trigger4: ["dynamicVC", "triggerChannelId4"], trigger5: ["dynamicVC", "triggerChannelId5"], afk: ["dynamicVC", "afkChannelId"], panel: ["dynamicVC", "createPanelChannelId"], introcheck: ["dynamicVC", "introCheckChannelId"], introsource: ["dynamicVC", "introSourceChannelId"], male: ["roles", "male"], female: ["roles", "female"] };
      const [s, k] = map[f]; saveConfig(d => { d[s][k] = val; if (s === "dynamicVC") dynamicVC[k] = val; else roles[k] = val; });
      await int.update({ content: "✅ 更新完了", embeds: [], components: [] }); autoDelete(int); setupSettingsPanel(); if (f === "panel") setupCreatePanel();
    }
    if (int.isUserSelectMenu() && cid.startsWith("vc_afk_select_")) {
      const target = await guild.members.fetch(int.values[0]).catch(() => null);
      if (target?.voice.channelId === cid.replace("vc_afk_select_", "")) { await target.voice.setChannel(dynamicVC.afkChannelId || "1496142556042498278"); await int.update({ content: `✅ <@${target.id}> 移動完了`, components: [] }); autoDelete(int, 3000); }
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
