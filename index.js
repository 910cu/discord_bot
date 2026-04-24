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
const features = Object.assign({
  introKickEnabled: true,
  genderRoleEnabled: true,
  vcIntroDisplayEnabled: true,
  afkEnabled: true,
  vcPanelEnabled: true,
  vcCreationEnabled: true
}, featuresConfig || {});

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error("❌ 環境変数 DISCORD_TOKEN が設定されていません。"); process.exit(1); }
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
    for (const [key, val] of Object.entries(defaultMessages)) { if (messagesConfig[key] === undefined) { messagesConfig[key] = val; updated = true; } }
    if (updated) fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));
  } else {
    messagesConfig = { ...defaultMessages };
    fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2));
  }
}
loadMessages();

const tempChannels = new Set(), profileMessageIds = new Map(), controlPanelMsgIds = new Map(), memberBios = new Map(), vcOwners = new Map(), lockedVCs = new Set(), genderMode = new Map(), pendingRequests = new Map(), allowedUsers = new Map(), knockNotifyMsgIds = new Map(), introPosted = new Map(), introMsgIds = new Map(), limitLockedVCs = new Set(), renameTimestamps = new Map(), profileUpdateQueue = new Map();

const canRename = (vcId) => {
  const now = Date.now(), stamps = (renameTimestamps.get(vcId) || []).filter(t => now - t < 600000);
  renameTimestamps.set(vcId, stamps);
  return stamps.length < 2;
};

async function updateVcName(vc, name = null, interaction = null) {
  if (!name || name === vc.name) return true;
  if (!canRename(vc.id)) {
    if (interaction) interaction.followUp({ content: "⚠️ 名前変更は10分間に2回までです。機能は適用されています。", ephemeral: true }).then(m => setTimeout(() => interaction.deleteReply().catch(() => { }), 15000));
    return false;
  }
  try { await vc.setName(name); renameTimestamps.get(vc.id).push(Date.now()); return true; } catch { return false; }
}

client.commands = new Collection();
for (const cmd of allCommands) client.commands.set(cmd.data.name, cmd);

async function deployCommands() {
  const rest = new REST().setToken(token);
  try { await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: allCommands.map(c => c.data.toJSON()) }); console.log("✅ コマンド登録完了"); } catch (err) { console.error(err); }
}

// ─── UIヘルパー ──────────────────────────────────────────────────────────────
const createBtn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const createRow = (components) => new ActionRowBuilder().addComponents(components);
const silentReply = async (i) => { try { await i.reply({ content: "\u200B" }); await i.deleteReply(); } catch { } };

// ─── 設定パネル・サブパネル用ペイロード生成 ──────────────────────────────────────
function getSettingsPayload(type = "main") {
  const on = "🟩", off = "🟥";
  let embed = new EmbedBuilder().setColor(0x2b2d31);
  let components = [];

  if (type === "main") {
    let desc = `-# Version 1.0.0 ｜ System: Operational\n\n`;
    const sections = [
      {
        cond: features.afkEnabled || features.vcPanelEnabled, title: "⚙️ 基本設定 [Basic]", lines: [
          { cond: features.afkEnabled, text: `> AFK (寝落ち) ─ ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}` },
          { cond: features.vcPanelEnabled, text: `> VC作成パネル ─ ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}` }
        ]
      },
      {
        cond: features.vcCreationEnabled, title: "➕ VC自動作成 [Creation]", lines: [
          { text: `> 自由枠 ─ ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"}` },
          { text: `> 4人部屋 ─ ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"}` },
          { text: `> 5人部屋 ─ ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}` }
        ]
      },
      {
        cond: features.introKickEnabled, title: "📝 未提出者自動整理 [Profile Guard]", lines: [
          { text: `- 提出確認チャンネル: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}` },
          { text: `> 警告 ─ 参加から ${dynamicVC.introWarnMinutes ?? 2880} 分後` },
          { text: `> 実行 ─ 参加から ${dynamicVC.introKickMinutes ?? 4320} 分後` }
        ]
      },
      {
        cond: features.vcIntroDisplayEnabled, title: "🖼️ VC内自己紹介表示 [Intro Display]", lines: [
          { text: `- 表示用ソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}` }
        ]
      },
      {
        cond: features.genderRoleEnabled, title: "🚻 部屋制限 [Room Guard]", lines: [
          { text: `> ♂️ ${roles.male ? `<@&${roles.male}>` : "`未設定`"}` },
          { text: `> ♀️ ${roles.female ? `<@&${roles.female}>` : "`未設定`"}` }
        ]
      }
    ];
    sections.forEach(s => { if (s.cond !== false) { desc += `### ${s.title}\n`; s.lines.forEach(l => { if (l.cond !== false) desc += l.text + "\n"; }); desc += "\n"; } });
    embed.setTitle("⬛ DIS COORDE | Control Panel").setDescription(desc || "（有効な機能がありません）");
    components = [
      createRow([createBtn("cfg_btn_afk", "💤 AFK設定"), createBtn("cfg_btn_panel", "🛠️ VC作成パネル設定"), createBtn("cfg_btn_trigger", "➕ VC自動作成")]),
      createRow([createBtn("cfg_btn_intro_kick", "📝 未提出者整理"), createBtn("cfg_btn_intro_display", "🖼️ VC内自己紹介表示")]),
      createRow([createBtn("cfg_btn_vc", "🚻 部屋制限"), createBtn("config_messages", "💬 メッセージ設定")])
    ];
  } else {
    const config = {
      afk: { title: "💤 AFK (寝落ち) 設定", desc: `- 💤 移動先: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}`, feature: "afkEnabled", toggle: "toggle_afk", label: "AFK機能", select: { id: "select_cfg_afk", ph: "💤 移動先を選択", type: [ChannelType.GuildVoice] } },
      panel: { title: "🛠️ VC作成パネル設定", desc: `- 🛠️ 設置先: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}`, feature: "vcPanelEnabled", toggle: "toggle_panel", label: "パネル機能", select: { id: "select_cfg_panel", ph: "🛠️ 設置先を選択", type: [ChannelType.GuildText] } },
      trigger: {
        title: "➕ VC自動作成設定", desc: `- 自由枠: ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"}\n- 4人: ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"}\n- 5人: ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}`, feature: "vcCreationEnabled", toggle: "toggle_vc_creation", label: "自動作成機能", selects: [
          { id: "select_cfg_trigger", ph: "➕ 自由枠トリガーを選択", type: [ChannelType.GuildVoice] },
          { id: "select_cfg_trigger4", ph: "👥 4人部屋トリガーを選択", type: [ChannelType.GuildVoice] },
          { id: "select_cfg_trigger5", ph: "👥 5人部屋トリガーを選択", type: [ChannelType.GuildVoice] }
        ]
      },
      intro_kick: { title: "📝 未提出者自動整理 設定", desc: `- 📝 提出確認: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n- ⚠️ 警告: ${dynamicVC.introWarnMinutes || 2880}分後\n- 🚪 キック: ${dynamicVC.introKickMinutes || 4320}分後`, feature: "introKickEnabled", toggle: "toggle_intro_kick", label: "自動整理", extraBtn: createBtn("config_intro_time", "⏱️ 期限設定", ButtonStyle.Primary), select: { id: "select_cfg_introcheck", ph: "📝 提出確認用を選択", type: [ChannelType.GuildText] } },
      intro_display: { title: "🖼️ VC内自己紹介表示 設定", desc: `- 📋 ソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}`, feature: "vcIntroDisplayEnabled", toggle: "toggle_vc_intro", label: "VC内表示", select: { id: "select_cfg_introsource", ph: "📋 ソースを選択", type: [ChannelType.GuildText] } },
      vc: {
        title: "🚻 部屋制限 設定", desc: `- ♂️ 男性ロール: ${roles.male ? `<@&${roles.male}>` : "`未設定`"}\n- ♀️ 女性ロール: ${roles.female ? `<@&${roles.female}>` : "`未設定`"}`, feature: "genderRoleEnabled", toggle: "toggle_gender", label: "部屋制限", selects: [
          { id: "select_cfg_male", ph: "♂️ 男性ロールを選択", role: true },
          { id: "select_cfg_female", ph: "♀️ 女性ロールを選択", role: true }
        ]
      }
    }[type];

    const isEnabled = features[config.feature];
    embed.setTitle(config.title).setDescription(`ステータス: ${isEnabled ? on : off}\n\n${config.desc}`);
    const row1Btns = [createBtn(config.toggle, `${config.label}: ${isEnabled ? "有効" : "無効"}`, isEnabled ? ButtonStyle.Success : ButtonStyle.Danger)];
    if (config.extraBtn) row1Btns.push(config.extraBtn.setDisabled(!isEnabled));
    components.push(createRow(row1Btns));

    (config.selects || [config.select]).filter(Boolean).forEach(s => {
      const menu = s.role ? new RoleSelectMenuBuilder() : new ChannelSelectMenuBuilder().setChannelTypes(s.type);
      components.push(createRow([menu.setCustomId(s.id).setPlaceholder(isEnabled ? s.ph : "⛔ 無効なため設定不可").setDisabled(!isEnabled)]));
    });
    components.push(createRow([createBtn("cfg_back_main", "⬅️ 戻る")]));
  }
  return { embeds: [embed], components, ephemeral: true };
}

const SETTINGS_CHANNEL_ID = "1496141555705319445";
function saveFeatures() {
  const configPath = "./config.json", fileData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  fileData.features = { ...features };
  fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2));
}
function bumpPanelVersion() {
  const configPath = "./config.json", fileData = JSON.parse(fs.readFileSync(configPath, "utf-8")), meta = fileData.meta || { version: 0, lastUpdated: null };
  meta.version = (meta.version || 0) + 1; meta.lastUpdated = new Date().toISOString(); fileData.meta = meta;
  fs.writeFileSync(configPath, JSON.stringify(fileData, null, 2)); return meta;
}

async function setupSettingsPanel() {
  const channel = client.channels.cache.get(SETTINGS_CHANNEL_ID); if (!channel) return;
  try { const msgs = await channel.messages.fetch({ limit: 10 }); for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { }); } catch { }
  const meta = bumpPanelVersion(), payload = getSettingsPayload("main");
  payload.embeds[0].setFooter({ text: `Last Updated: ${new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` });
  await channel.send(payload);
}

async function setupCreatePanel() {
  const channelId = dynamicVC.createPanelChannelId; if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId); if (!channel) return;
    const msgs = await channel.messages.fetch({ limit: 20 }); for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🎙️ ボイスチャンネルを作成する").setDescription("下のボタンから作成したいVCの種類を選んでください。\n※人数固定の部屋は、作成後に人数の変更ができません。");
    const row = createRow([createBtn("create_vc_panel", "➕ 新しい通話を作成", ButtonStyle.Success), createBtn("create_vc_4", "👥 雑談4人部屋作成", ButtonStyle.Primary), createBtn("create_vc_5", "👥 雑談5人部屋作成", ButtonStyle.Primary)]);
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) { console.error(err.message); }
}

function buildProfileEmbed(member) {
  const bio = memberBios.get(member.id) ?? null;
  const embed = new EmbedBuilder().setColor(member.displayColor || 0x5865f2).setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL({ size: 64 }) }).setThumbnail(member.user.displayAvatarURL({ size: 256 })).addFields({ name: "📅 参加日", value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:D>` : "不明", inline: true }, { name: "🏷️ ロール", value: member.roles.cache.filter(r => r.id !== member.guild.id).sort((a, b) => b.position - a.position).map(r => `<@&${r.id}>`).join(" ") || "なし", inline: false });
  if (bio) embed.addFields({ name: "📝 自己紹介", value: bio, inline: false });
  return embed;
}

async function updateProfileMessage(vc) {
  if (!vc) return;
  if (profileUpdateQueue.get(vc.id)) return profileUpdateQueue.get(vc.id).then(() => updateProfileMessage(vc));

  const updatePromise = (async () => {
    const members = [...vc.members.values()], msgId = profileMessageIds.get(vc.id);
    if (members.length === 0) {
      if (msgId) try { await (await vc.messages.fetch(msgId)).delete(); } catch { }
      profileMessageIds.delete(vc.id);
      return;
    }
    const payload = { embeds: members.map(buildProfileEmbed) };
    try {
      if (msgId) {
        try { await (await vc.messages.fetch(msgId)).edit(payload); }
        catch { const s = await vc.send(payload); profileMessageIds.set(vc.id, s.id); }
      } else {
        const s = await vc.send(payload);
        profileMessageIds.set(vc.id, s.id);
      }
    } catch { }
  })();

  profileUpdateQueue.set(vc.id, updatePromise);
  await updatePromise;
  profileUpdateQueue.delete(vc.id);
}

function buildPanelPayload(vc) {
  const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, ownerId = vcOwners.get(vc.id), isFixed = limitLockedVCs.has(vc.id);
  const embed = new EmbedBuilder().setColor(locked ? 0xe74c3c : 0x57f287).setDescription(`### 👑 部屋主: <@${ownerId}>\n\n▼ **設定状況**\n> **状態** ─ ${locked ? "🔴 LOCKED" : "Open"}\n> **上限** ─ ${limit === 0 ? "∞ 無制限" : limit + "人"}\n> **制限** ─ ${gender === "male" ? "♂️ 男性のみ" : gender === "female" ? "♀️ 女性のみ" : "👥 なし"}`);
  if (isFixed) return { embeds: [embed], components: [createRow([createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !features.afkEnabled)])] };
  const row1 = createRow([createBtn("vc_rename", "✏️ 名前変更"), createBtn("vc_toggle_lock", locked ? "🔓 解除" : "🔒 ロック", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 制限設定", ButtonStyle.Secondary, !features.genderRoleEnabled), createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !features.afkEnabled)]);
  return { embeds: [embed], components: locked ? [row1, createRow([createBtn("label_knock", "【参加希望】", ButtonStyle.Secondary, true), createBtn(`vc_knock_${vc.id}`, "🚪 ノックして申請", ButtonStyle.Success)])] : [row1] };
}

function buildVCSettingsPayload(vc) {
  const gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = (n) => limit === n ? ButtonStyle.Success : ButtonStyle.Secondary;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle(`🛡️ 制限設定 | ${vc.name}`).setDescription(`上限: ${limit === 0 ? "∞" : limit}人 / 性別: ${gender || "なし"}`);
  return { embeds: [embed], components: [createRow([createBtn("label_g", "【性別】", ButtonStyle.Secondary, true), createBtn("vc_gender_none", "なし", gStyle(null), !features.genderRoleEnabled), createBtn("vc_gender_male", "♂️ 男性", gStyle("male"), !features.genderRoleEnabled), createBtn("vc_gender_female", "♀️ 女性", gStyle("female"), !features.genderRoleEnabled)]), createRow([createBtn("label_l", "【人数】", ButtonStyle.Secondary, true), createBtn("vc_limit_0", "∞", lStyle(0)), createBtn("vc_limit_4", "4人", lStyle(4)), createBtn("vc_limit_5", "5人", lStyle(5)), createBtn("vc_limit_custom", "指定...", ButtonStyle.Primary)]), createRow([createBtn("vc_main_panel", "⬅️ 戻る")])] };
}

async function sendOrUpdateControlPanel(vc) {
  const oldId = controlPanelMsgIds.get(vc.id), payload = buildPanelPayload(vc);
  if (oldId) try { await (await vc.messages.fetch(oldId)).edit(payload); return; } catch { }
  try { const s = await vc.send(payload); controlPanelMsgIds.set(vc.id, s.id); } catch { }
}

async function updateKnockNotifyMessage(vc, ownerId) {
  const pending = pendingRequests.get(vc.id), applicantIds = pending ? [...pending.keys()] : [];
  if (applicantIds.length === 0) { const id = knockNotifyMsgIds.get(vc.id); if (id) try { await (await vc.messages.fetch(id)).delete(); } catch { } knockNotifyMsgIds.delete(vc.id); return; }
  const embeds = [new EmbedBuilder().setColor(0xf39c12).setTitle("🚪 ノックされています"), ...applicantIds.map(uid => new EmbedBuilder().setColor(0xf39c12).setDescription(`<@${uid}> が入室しようとしています。`).setThumbnail(vc.guild.members.cache.get(uid)?.user.displayAvatarURL() || null))];
  const rows = applicantIds.slice(0, 5).map(uid => createRow([createBtn(`knock_approve_${vc.id}_${uid}`, "✅ 許可", ButtonStyle.Success), createBtn(`knock_deny_${vc.id}_${uid}`, "❌ 拒否", ButtonStyle.Danger)]));
  const id = knockNotifyMsgIds.get(vc.id); try { if (id) await (await vc.messages.fetch(id)).edit({ embeds, components: rows }); else { const s = await vc.send({ embeds, components: rows }); knockNotifyMsgIds.set(vc.id, s.id); } } catch { }
}

// ─── インタラクション処理 ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (i) => {
  if (i.isChatInputCommand()) { const cmd = client.commands.get(i.commandName); if (cmd) cmd.execute(i).catch(console.error); return; }

  if (i.isButton()) {
    const cid = i.customId;
    if (cid.startsWith("create_vc_")) {
      if (!features.vcPanelEnabled) return i.reply({ content: "無効です", ephemeral: true });
      const limit = cid === "create_vc_4" ? 4 : cid === "create_vc_5" ? 5 : 0;
      return i.showModal(new ModalBuilder().setCustomId(`create_vc_modal_${limit}`).setTitle("VC作成").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("名前").setStyle(TextInputStyle.Short).setValue(`${i.member.displayName}のVC`).setRequired(true)])));
    }
    if (cid === "vc_toggle_lock") {
      const vc = i.member.voice.channel; if (!vc || !tempChannels.has(vc.id) || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      lockedVCs.has(vc.id) ? lockedVCs.delete(vc.id) : lockedVCs.add(vc.id);
      return i.update(buildPanelPayload(vc));
    }
    if (cid === "vc_settings_btn") { const vc = i.member.voice.channel; if (vc && tempChannels.has(vc.id) && vcOwners.get(vc.id) === i.user.id && features.genderRoleEnabled) return i.update(buildVCSettingsPayload(vc)); return i.deferUpdate(); }
    if (cid === "vc_main_panel") { const vc = i.member.voice.channel; if (vc && tempChannels.has(vc.id)) return i.update(buildPanelPayload(vc)); return i.deferUpdate(); }
    if (cid.startsWith("vc_gender_")) {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      const mode = cid.split("_")[2]; if (mode === "none") genderMode.delete(vc.id); else genderMode.set(vc.id, mode);
      await i.update(buildVCSettingsPayload(vc));
      const overwrites = [{ id: vc.guild.roles.everyone.id, [mode ? 'deny' : 'allow']: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }];
      if (mode) overwrites.push({ id: roles[mode], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: roles[mode === 'male' ? 'female' : 'male'], deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
      return vc.permissionOverwrites.set(overwrites).catch(console.error);
    }
    if (cid.startsWith("vc_limit_") && cid !== "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: messagesConfig.limitLockedWarning, ephemeral: true });
      await vc.setUserLimit(parseInt(cid.split("_")[2])); return i.update(buildVCSettingsPayload(vc));
    }
    if (cid === "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: messagesConfig.limitLockedWarning, ephemeral: true });
      return i.showModal(new ModalBuilder().setCustomId(`limit_modal_${vc.id}`).setTitle("上限設定").addComponents(createRow([new TextInputBuilder().setCustomId("limit").setLabel("人数(0-99)").setStyle(TextInputStyle.Short).setRequired(true)])));
    }
    if (cid === "vc_rename") { const vc = i.member.voice.channel; if (vc && vcOwners.get(vc.id) === i.user.id) return i.showModal(new ModalBuilder().setCustomId(`rename_modal_${vc.id}`).setTitle("名前変更").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("新しい名前").setStyle(TextInputStyle.Short).setRequired(true)]))); return i.deferUpdate(); }
    if (cid === "vc_afk_prompt") {
      if (!features.afkEnabled) return i.reply({ content: "無効", ephemeral: true });
      const vc = i.member.voice.channel; if (!vc || vc.id !== i.channelId) return i.reply({ content: "このVCに参加中のみ可", ephemeral: true });
      return i.reply({ content: "移動させる人を選択", components: [createRow([new UserSelectMenuBuilder().setCustomId(`vc_afk_select_${vc.id}`).setPlaceholder("選択").setMaxValues(1)])], ephemeral: true });
    }
    if (cid === "cfg_back_main") return i.update(getSettingsPayload("main"));
    if (cid.startsWith("cfg_btn_")) return i.update(getSettingsPayload(cid.replace("cfg_btn_", "")));
    const toggles = { toggle_afk: "afkEnabled", toggle_panel: "vcPanelEnabled", toggle_vc_creation: "vcCreationEnabled", toggle_intro_kick: "introKickEnabled", toggle_vc_intro: "vcIntroDisplayEnabled", toggle_gender: "genderRoleEnabled" };
    if (toggles[cid]) {
      const key = toggles[cid]; features[key] = !features[key]; saveFeatures();
      if (key === "genderRoleEnabled" && !features[key]) { for (const id of tempChannels) { if (genderMode.has(id)) { genderMode.delete(id); const vc = client.channels.cache.get(id); if (vc) vc.permissionOverwrites.set([{ id: vc.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }]).catch(() => { }); } } }
      await i.update(getSettingsPayload(cid.replace("toggle_", "").replace("gender", "vc").replace("vc_creation", "trigger").replace("vc_intro", "intro_display")));
      return setupSettingsPanel();
    }
    if (cid === "config_intro_time") return i.showModal(new ModalBuilder().setCustomId("intro_time_modal").setTitle("期限設定").addComponents(createRow([new TextInputBuilder().setCustomId("warn").setLabel("警告(分)").setStyle(TextInputStyle.Short).setValue(String(dynamicVC.introWarnMinutes || 2880))]), createRow([new TextInputBuilder().setCustomId("kick").setLabel("キック(分)").setStyle(TextInputStyle.Short).setValue(String(dynamicVC.introKickMinutes || 4320))])));
    if (cid === "config_messages") return i.reply({ content: "編集カテゴリ選択", components: [createRow([createBtn("msg_modal_intro", "自己紹介関連", ButtonStyle.Primary), createBtn("msg_modal_vc", "VC関連", ButtonStyle.Primary)])], ephemeral: true });
    if (cid.startsWith("msg_modal_")) {
      const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"], labels = isIntro ? ["確認通知", "期限警告", "未記入キックDM"] : ["上限固定エラー", "男性専用エラーDM", "女性専用エラーDM"];
      return i.showModal(new ModalBuilder().setCustomId(`msg_submit_${isIntro ? 'intro' : 'vc'}`).setTitle("メッセージ編集").addComponents(keys.map((k, j) => createRow([new TextInputBuilder().setCustomId(k).setLabel(labels[j]).setStyle(TextInputStyle.Paragraph).setValue((messagesConfig[k] || "").replace(/\\n/g, '\n'))]))));
    }
    if (cid.startsWith("vc_knock_")) {
      const vcId = cid.replace("vc_knock_", ""), vc = i.guild.channels.cache.get(vcId); if (!vc || i.member.voice.channelId === vcId || vcOwners.get(vcId) === i.user.id || !lockedVCs.has(vcId)) return i.deferUpdate();
      if (!pendingRequests.has(vcId)) pendingRequests.set(vcId, new Map()); pendingRequests.get(vcId).set(i.user.id, true); await updateKnockNotifyMessage(vc, vcOwners.get(vcId)); return i.reply({ content: "✅ 申請しました", ephemeral: true });
    }
    if (cid.startsWith("knock_approve_") || cid.startsWith("knock_deny_")) {
      const [, , vcId, uid] = cid.split("_"), vc = i.guild.channels.cache.get(vcId); if (vcOwners.get(vcId) !== i.user.id || !vc) return i.deferUpdate();
      await i.deferUpdate(); pendingRequests.get(vcId)?.delete(uid);
      if (cid.includes("approve")) { if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set()); allowedUsers.get(vcId).add(uid); const m = await i.guild.members.fetch(uid).catch(() => null); if (m?.voice.channel) m.voice.setChannel(vc).catch(() => vc.send(`✅ <@${uid}> 入室許可`)); else vc.send(`✅ <@${uid}> 入室許可`).then(msg => setTimeout(() => msg.delete().catch(() => { }), 60000)); }
      return updateKnockNotifyMessage(vc, i.user.id);
    }
    if (cid.startsWith("bio_input_")) return i.user.id === cid.replace("bio_input_", "") ? i.showModal(new ModalBuilder().setCustomId(`bio_modal_${i.user.id}`).setTitle("自己紹介入力").addComponents(createRow([new TextInputBuilder().setCustomId("bio").setLabel("自己紹介").setStyle(TextInputStyle.Paragraph).setMaxLength(300)]))) : i.deferUpdate();
  }

  if (i.isModalSubmit()) {
    const cid = i.customId;
    if (cid.startsWith("create_vc_modal_")) {
      const name = i.fields.getTextInputValue("name"), limit = parseInt(cid.split("_")[3]); await silentReply(i);
      try { const vc = await i.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: dynamicVC.cleanupCategoryId, userLimit: limit, permissionOverwrites: [{ id: i.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] }); tempChannels.add(vc.id); vcOwners.set(vc.id, i.user.id); if (limit) limitLockedVCs.add(vc.id); await sendOrUpdateControlPanel(vc); } catch { }
    }
    if (cid.startsWith("limit_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("limit_modal_", "")), val = parseInt(i.fields.getTextInputValue("limit")); await silentReply(i); if (vc && !isNaN(val)) { await vc.setUserLimit(val); await sendOrUpdateControlPanel(vc); } }
    if (cid.startsWith("rename_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("rename_modal_", "")); await silentReply(i); if (vc) await updateVcName(vc, i.fields.getTextInputValue("name").trim()); }
    if (cid === "intro_time_modal") { const w = parseInt(i.fields.getTextInputValue("warn")), k = parseInt(i.fields.getTextInputValue("kick")); if (!isNaN(w) && !isNaN(k)) { dynamicVC.introWarnMinutes = w; dynamicVC.introKickMinutes = k; const c = JSON.parse(fs.readFileSync("./config.json", "utf-8")); c.dynamicVC.introWarnMinutes = w; c.dynamicVC.introKickMinutes = k; fs.writeFileSync("./config.json", JSON.stringify(c, null, 2)); await i.update({ content: "✅ 更新しました", embeds: [], components: [] }); setupSettingsPanel(); } }
    if (cid.startsWith("msg_submit_")) { const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"]; keys.forEach(k => { messagesConfig[k] = i.fields.getTextInputValue(k).replace(/\n/g, '\\n'); }); fs.writeFileSync(msgConfigPath, JSON.stringify(messagesConfig, null, 2)); return i.reply({ content: "✅ 更新完了", ephemeral: true }); }
    if (cid.startsWith("bio_modal_")) { const bio = i.fields.getTextInputValue("bio").trim(); await silentReply(i); if (bio) memberBios.set(i.user.id, bio); else memberBios.delete(i.user.id); if (i.member.voice.channel) updateProfileMessage(i.member.voice.channel); }
  }

  if (i.isAnySelectMenu() && i.customId.startsWith("select_cfg_")) {
    const field = i.customId.replace("select_cfg_", ""), val = i.values[0], config = JSON.parse(fs.readFileSync("./config.json", "utf-8")), map = { trigger: "triggerChannelId", trigger4: "triggerChannelId4", trigger5: "triggerChannelId5", afk: "afkChannelId", panel: "createPanelChannelId", introcheck: "introCheckChannelId", introsource: "introSourceChannelId" };
    if (map[field]) { config.dynamicVC[map[field]] = val; dynamicVC[map[field]] = val; } else { config.roles[field] = val; roles[field] = val; }
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2)); await i.update({ content: "✅ 更新しました", embeds: [], components: [] }); setupSettingsPanel(); if (field === "panel") setupCreatePanel();
  }
  if (i.isUserSelectMenu() && i.customId.startsWith("vc_afk_select_")) {
    const vcId = i.customId.split("_")[3], target = await i.guild.members.fetch(i.values[0]).catch(() => null);
    if (!i.member.voice.channel || i.member.voice.channelId !== vcId || !target || target.voice.channelId !== vcId) return i.reply({ content: "無効", ephemeral: true });
    try { await target.voice.setChannel(dynamicVC.afkChannelId || "1496142556042498278"); await i.update({ content: "✅ 移動しました", components: [] }); } catch { await i.update({ content: "❌ 失敗", components: [] }); }
  }
});

// ─── VoiceStateUpdate ─────────────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (o, n) => {
  const triggers = [dynamicVC.triggerChannelId, dynamicVC.triggerChannelId4, dynamicVC.triggerChannelId5];
  if (n.channelId && triggers.includes(n.channelId) && features.vcCreationEnabled) {
    const limit = n.channelId === triggers[1] ? 4 : n.channelId === triggers[2] ? 5 : 0;
    try { const vc = await n.guild.channels.create({ name: limit ? `雑談${limit}人部屋` : dynamicVC.channelName.replace("{user}", n.member.displayName), type: ChannelType.GuildVoice, parent: n.channel.parentId, userLimit: limit, permissionOverwrites: [{ id: n.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] }); tempChannels.add(vc.id); vcOwners.set(vc.id, n.member.id); if (limit) limitLockedVCs.add(vc.id); await n.member.voice.setChannel(vc); await sendOrUpdateControlPanel(vc); } catch { }
    return;
  }
  if (n.channelId && tempChannels.has(n.channelId)) {
    const vc = n.channel, m = n.member, gender = genderMode.get(vc.id);
    if (features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== m.id && !m.roles.cache.has(roles[gender])) { try { await m.voice.disconnect(); m.send((messagesConfig[gender === 'male' ? 'genderMaleOnlyDM' : 'genderFemaleOnlyDM'] || "").replace(/{vcName}/g, vc.name).replace(/\\n/g, '\n')).catch(() => { }); } catch { } return; }
    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== m.id && !allowedUsers.get(vc.id)?.has(m.id)) { try { await m.voice.disconnect(); if (!pendingRequests.has(vc.id)) pendingRequests.set(vc.id, new Map()); pendingRequests.get(vc.id).set(m.id, true); await updateKnockNotifyMessage(vc, vcOwners.get(vc.id)); } catch { } return; }
    if (o.channelId !== n.channelId && features.vcIntroDisplayEnabled) { const db = fs.existsSync("./introDB.json") ? JSON.parse(fs.readFileSync("./introDB.json", "utf-8")) : {}; if (db[m.id]?.content) { if (!introPosted.has(vc.id)) introPosted.set(vc.id, new Set()); if (!introPosted.get(vc.id).has(m.id)) { introPosted.get(vc.id).add(m.id); const msg = await vc.send({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setThumbnail(m.user.displayAvatarURL()).setDescription(`## ${m.displayName}\n> ${db[m.id].content}`).setFooter({ text: "DIS COORDE Profile System" })] }).catch(() => null); if (msg) introMsgIds.set(`${vc.id}_${m.id}`, msg.id); } } }
    updateProfileMessage(vc);
  }
  if (o.channelId && tempChannels.has(o.channelId) && o.channelId !== n.channelId) {
    const ch = o.channel, key = `${o.channelId}_${o.member.id}`; if (introMsgIds.has(key)) { try { await (await ch.messages.fetch(introMsgIds.get(key))).delete(); } catch { } introMsgIds.delete(key); introPosted.get(o.channelId)?.delete(o.member.id); }
    if (ch?.members.size === 0) { try { await ch.delete();[tempChannels, profileMessageIds, controlPanelMsgIds, lockedVCs, genderMode, vcOwners, pendingRequests, allowedUsers, knockNotifyMsgIds, renameTimestamps, introPosted, limitLockedVCs].forEach(s => s.delete(o.channelId)); } catch { } }
    else if (ch && vcOwners.get(ch.id) === o.member.id) { const next = ch.members.first(); if (next) { vcOwners.set(ch.id, next.id); await sendOrUpdateControlPanel(ch); } }
    if (ch) updateProfileMessage(ch);
  }
});

const handleIntroUpdate = async (msg, type = "create") => {
  const isDel = type === "delete"; if (msg.partial && !isDel) await msg.fetch().catch(() => { });
  const checkCh = dynamicVC.introCheckChannelId || dynamicVC.introChannelId, sourceCh = dynamicVC.introSourceChannelId || dynamicVC.introChannelId;
  if (![checkCh, sourceCh].includes(msg.channelId) || msg.author?.bot) return;
  const db = fs.existsSync("./introDB.json") ? JSON.parse(fs.readFileSync("./introDB.json", "utf-8")) : {};
  const uid = msg.author?.id; if (!uid) return syncIntrosOnly(msg.guild);
  if (isDel) {
    const userMsgs = (await msg.channel.messages.fetch({ limit: 50 })).filter(m => m.author.id === uid);
    if (userMsgs.size === 0) { if (db[uid] && msg.channelId === sourceCh) delete db[uid].content; }
    else { const last = userMsgs.first(); if (!db[uid]) db[uid] = {}; if (msg.channelId === checkCh) db[uid].introduced = true; if (msg.channelId === sourceCh) db[uid].content = (last.content + (last.attachments.size ? "\n" + last.attachments.map(a => a.url).join("\n") : "")).trim(); }
  } else {
    if (!db[uid]) db[uid] = {}; if (msg.channelId === checkCh) db[uid].introduced = true;
    if (msg.channelId === sourceCh) db[uid].content = (msg.content + (msg.attachments.size ? "\n" + msg.attachments.map(a => a.url).join("\n") : "")).trim();
    if (type === "create" && msg.channelId === checkCh) { if (db[uid].warnMsgId) { try { await (await msg.guild.channels.cache.get(checkCh).messages.fetch(db[uid].warnMsgId)).delete(); } catch { } delete db[uid].warnMsgId; } msg.reply({ content: (messagesConfig.introNotify || "✅ <@{user}> 確認").replace(/{user}/g, uid).replace(/\\n/g, '\n') }).then(r => setTimeout(() => r.delete().catch(() => { }), 10000)).catch(() => { }); }
  }
  fs.writeFileSync("./introDB.json", JSON.stringify(db, null, 2));
};

client.on(Events.MessageCreate, m => handleIntroUpdate(m, "create"));
client.on(Events.MessageUpdate, (o, n) => handleIntroUpdate(n, "update"));
client.on(Events.MessageDelete, m => handleIntroUpdate(m, "delete"));

async function syncIntrosOnly(guild) {
  const checkCh = dynamicVC.introCheckChannelId || dynamicVC.introChannelId, sourceCh = dynamicVC.introSourceChannelId || dynamicVC.introChannelId, db = fs.existsSync("./introDB.json") ? JSON.parse(fs.readFileSync("./introDB.json", "utf-8")) : {};
  const fetchAll = async (ch) => {
    let authors = new Map(), last = null; while (true) { const msgs = await ch.messages.fetch({ limit: 100, before: last }).catch(() => new Map()); if (msgs.size === 0) break; msgs.forEach(m => { if (!m.author.bot && !authors.has(m.author.id)) authors.set(m.author.id, (m.content + (m.attachments.size ? "\n" + m.attachments.map(a => a.url).join("\n") : "")).trim()); }); last = msgs.last().id; if (msgs.size < 100) break; } return authors;
  };
  const checks = await fetchAll(guild.channels.cache.get(checkCh)), sources = checkCh === sourceCh ? checks : await fetchAll(guild.channels.cache.get(sourceCh));
  Object.keys(db).forEach(uid => { if (checks.has(uid)) db[uid].introduced = true; if (sources.has(uid)) db[uid].content = sources.get(uid); else delete db[uid].content; });
  fs.writeFileSync("./introDB.json", JSON.stringify(db, null, 2));
}

async function syncAndCheckIntros(guild) {
  await syncIntrosOnly(guild);
  setInterval(async () => {
    if (!features.introKickEnabled) return;
    const db = JSON.parse(fs.readFileSync("./introDB.json", "utf-8")), members = await guild.members.fetch(), now = Date.now(), updated = [];
    for (const m of members.values()) {
      if (m.user.bot || db[m.id]?.introduced) continue;
      const elapsed = now - m.joinedTimestamp, warn = (dynamicVC.introWarnMinutes || 2880) * 60000, kick = (dynamicVC.introKickMinutes || 4320) * 60000;
      if (elapsed >= kick) { try { await m.send((messagesConfig.introKickDM || "未記入のためキック").replace(/\\n/g, '\n')); } catch { } await m.kick("未記入"); db[m.id] = { kicked: true }; updated.push(m.id); }
      else if (elapsed >= warn && !db[m.id]?.warned) { db[m.id] = { ...db[m.id], warned: true }; updated.push(m.id); const w = await guild.channels.cache.get(dynamicVC.introCheckChannelId || dynamicVC.introChannelId).send((messagesConfig.introWarnMsg || "⚠️ <@{user}> 期限間近").replace(/{user}/g, m.id).replace(/{leftMinutes}/g, Math.floor((kick - elapsed) / 60000)).replace(/\\n/g, '\n')); db[m.id].warnMsgId = w.id; setTimeout(() => w.delete().catch(() => { }), kick - elapsed); }
    }
    if (updated.length) fs.writeFileSync("./introDB.json", JSON.stringify(db, null, 2));
  }, 60000);
}

client.once(Events.ClientReady, async () => {
  setupSettingsPanel(); setupCreatePanel();
  if (!dynamicVC?.cleanupCategoryId) return;
  try {
    const guild = await client.guilds.fetch(guildId); syncAndCheckIntros(guild);
    (await guild.channels.fetch()).filter(c => c.type === ChannelType.GuildVoice && c.parentId === dynamicVC.cleanupCategoryId && c.id !== dynamicVC.triggerChannelId && c.members.size === 0 && c.name.includes("🔊")).forEach(c => c.delete());
  } catch { }
});

client.login(token);
