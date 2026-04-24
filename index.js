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
const mongoose = require("mongoose");

// ─── 環境変数と基本設定 ────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
const mongoUri = process.env.MONGO_URI;
if (!token) { console.error("❌ 環境変数 DISCORD_TOKEN が設定されていません。"); process.exit(1); }
if (!mongoUri) { console.warn("⚠️ MONGO_URI が設定されていません。ローカルDBを使用します。"); }

const { clientId, guildId } = require("./config.json");
const allCommands = require("./commands");

// ─── MongoDB スキーマ定義 ──────────────────────────────────────────────────────
const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  dynamicVC: { type: Object, default: {} },
  roles: { type: Object, default: {} },
  features: { type: Object, default: {} },
  meta: { type: Object, default: { version: 1, lastUpdated: new Date().toISOString() } },
  messages: { type: Object, default: {} }
});

const introSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  introduced: { type: Boolean, default: false },
  content: { type: String, default: "" },
  warnMsgId: { type: String, default: null },
  warned: { type: Boolean, default: false },
  kicked: { type: Boolean, default: false }
});
introSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const Guild = mongoose.model("Guild", guildSchema);
const Intro = mongoose.model("Intro", introSchema);

// ─── DB接続 ──────────────────────────────────────────────────────────────────
mongoose.connect(mongoUri || "mongodb://localhost:27017/discordbot")
  .then(() => console.log("🍃 MongoDB 接続完了"))
  .catch(err => console.error("❌ MongoDB 接続エラー:", err));

// ─── グローバル変数と初期化 ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.commands = new Collection();
for (const cmd of allCommands) {
  client.commands.set(cmd.data.name, cmd);
}

const defaultMessages = {
  "introNotify": "✅ <@{user}> さんの自己紹介を確認しました！",
  "limitLockedWarning": "⚠️ この部屋は作成時に人数が固定されているため、変更できません。",
  "genderMaleOnlyDM": "🚫 {vcName} は ♂️ 男性専用 VCのため入室できません。",
  "genderFemaleOnlyDM": "🚫 {vcName} は ♀️ 女性専用 VCのため入室できません。",
  "introWarnMsg": "⚠️ <@{user}> さん、自己紹介の提出期限が迫っています。\\nあと **{leftMinutes}分** 以内にこのチャンネルに自己紹介を記入しないと、自動的に退出となりますのでご注意ください！",
  "introKickDM": "サーバー参加後、指定された期間内に自己紹介の記入がなかったため、サーバーから自動退出となりました。"
};

const tempChannels = new Set(), controlPanelMsgIds = new Map(), vcOwners = new Map(), lockedVCs = new Set(), genderMode = new Map(), pendingRequests = new Map(), allowedUsers = new Map(), knockNotifyMsgIds = new Map(), introPosted = new Map(), introMsgIds = new Map(), limitLockedVCs = new Set(), renameTimestamps = new Map();
const guildCache = new Map();

// ─── データ管理ユーティリティ ──────────────────────────────────────────────────
const defaultFeatures = {
  afkEnabled: false,
  vcPanelEnabled: false,
  vcCreationEnabled: false,
  introKickEnabled: false,
  vcIntroDisplayEnabled: false,
  genderRoleEnabled: false
};

const defaultDynamicVC = {
  channelName: "{user}のVC",
  channelName4: "雑談4人部屋",
  channelName5: "雑談5人部屋",
  introWarnMinutes: 2880,
  introKickMinutes: 4320
};

async function getGuildConfig(gid, forceRefresh = false) {
  if (!forceRefresh && guildCache.has(gid)) return guildCache.get(gid);

  let g = await Guild.findOne({ guildId: gid });
  
  // 既存データがない、または機能設定が完全に空の場合に移行/初期化を試みる
  const isNewOrEmpty = !g || (!g.features || Object.keys(g.features).length === 0);

  if (isNewOrEmpty && gid === guildId) {
    try {
      const local = require("./config.json");
      const msgs = fs.existsSync("./messages.json") ? JSON.parse(fs.readFileSync("./messages.json", "utf-8")) : defaultMessages;
      
      const initialData = {
        guildId: gid,
        dynamicVC: { ...defaultDynamicVC, ...local.dynamicVC },
        roles: local.roles || {},
        features: { ...defaultFeatures, ...local.features },
        messages: msgs
      };

      if (!g) {
        g = await Guild.create(initialData);
        console.log(`📦 Guild ${gid}: 初期データを config.json からインポートしました。`);
      } else {
        await Guild.updateOne({ guildId: gid }, { $set: initialData });
        g = await Guild.findOne({ guildId: gid });
        console.log(`📦 Guild ${gid}: 既存の空データを config.json の内容で更新しました。`);
      }
    } catch (err) {
      console.error("❌ 初期データ移行エラー:", err);
    }
  }

  if (!g) {
    g = await Guild.create({ 
      guildId: gid, 
      dynamicVC: defaultDynamicVC, 
      features: defaultFeatures, 
      messages: defaultMessages 
    });
  }
  guildCache.set(gid, g);
  return g;
}

async function updateGuildConfig(gid, data) {
  await Guild.updateOne({ guildId: gid }, data);
  guildCache.delete(gid); // キャッシュ破棄
}

async function updateIntro(gid, uid, data) {
  return await Intro.findOneAndUpdate({ guildId: gid, userId: uid }, { $set: data }, { upsert: true, new: true });
}

// ─── UIヘルパー ──────────────────────────────────────────────────────────────
const createBtn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const createRow = (components) => new ActionRowBuilder().addComponents(components);
const silentReply = async (i) => { try { await i.reply({ content: "\u200B" }); await i.deleteReply(); } catch { } };

// ─── 設定パネル用ペイロード生成 ──────────────────────────────────────
async function getSettingsPayload(gid, type = "main", config = null) {
  const doc = config || await getGuildConfig(gid);
  const g = doc.toObject ? doc.toObject() : doc;
  const dynamicVC = g.dynamicVC || {};
  const roles = g.roles || {};
  const features = { ...defaultFeatures, ...(g.features || {}) };
  const messages = g.messages || {};
  
  const guild = client.guilds.cache.get(gid);
  const guildName = guild ? guild.name : "Unknown Server";

  const on = "●", off = "○";
  let embed = new EmbedBuilder().setColor(0x2b2d31);
  let components = [];

  if (type === "main") {
    let desc = `# ${guildName}\n-# v1.2.0 (Multi-Guild Mode)\n\n`;
    const sections = [
      {
        cond: features.afkEnabled || features.vcPanelEnabled, title: "基本設定", lines: [
          { cond: features.afkEnabled, text: `AFK (寝落ち) ─ ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}` },
          { cond: features.vcPanelEnabled, text: `VC作成パネル ─ ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}` }
        ]
      },
      {
        cond: features.vcCreationEnabled, title: "VC自動作成", lines: [
          { text: `自由枠 ─ ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"} (\`${dynamicVC.channelName}\`)` },
          { text: `4人部屋 ─ ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"} (\`${dynamicVC.channelName4 || "雑談4人部屋"}\`)` },
          { text: `5人部屋 ─ ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"} (\`${dynamicVC.channelName5 || "雑談5人部屋"}\`)` }
        ]
      },
      {
        cond: features.introKickEnabled, title: "未提出者自動整理", lines: [
          { text: `確認先: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}` },
          { text: `警告 ─ 参加 ${dynamicVC.introWarnMinutes ?? 2880} 分後` },
          { text: `実行 ─ 参加 ${dynamicVC.introKickMinutes ?? 4320} 分後` }
        ]
      },
      {
        cond: features.vcIntroDisplayEnabled, title: "VC内自己紹介表示", lines: [
          { text: `ソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}` }
        ]
      },
      {
        cond: features.genderRoleEnabled, title: "部屋制限設定", lines: [
          { text: `♂️ ${roles.male ? `<@&${roles.male}>` : "`未設定`"}` },
          { text: `♀️ ${roles.female ? `<@&${roles.female}>` : "`未設定`"}` }
        ]
      }
    ];
    sections.forEach(s => {
      const isSectionOff = s.cond === false;
      desc += `### ${s.title}${isSectionOff ? " ⦗無効⦘" : ""}\n`;
      s.lines.forEach(l => {
        const isOff = l.cond === false || isSectionOff;
        const parts = l.text.split(' ─ ');
        if (parts.length === 2) {
          let label = parts[0];
          let value = parts[1];
          let indicator = "";
          if (value === "`未設定`" || isOff) indicator = " 🟥";
          desc += `-# ${label}\n┕ ${isOff ? "`無効`" : value}${indicator}\n`;
        } else {
          desc += `> ${l.text}${isOff ? " 🟥" : ""}\n`;
        }
      });
      desc += "\n";
    });
    embed.setTitle(null).setDescription(desc);
    const bStyle = (feat) => features[feat] ? ButtonStyle.Secondary : ButtonStyle.Danger;
    components = [
      createRow([createBtn("cfg_btn_afk", "💤 AFK", bStyle("afkEnabled")), createBtn("cfg_btn_panel", "🛠️ パネル", bStyle("vcPanelEnabled")), createBtn("cfg_btn_trigger", "➕ 自動作成", bStyle("vcCreationEnabled"))]),
      createRow([createBtn("cfg_btn_intro_kick", "📝 自動整理", bStyle("introKickEnabled")), createBtn("cfg_btn_intro_display", "🖼️ 紹介表示", bStyle("vcIntroDisplayEnabled"))]),
      createRow([createBtn("cfg_btn_vc", "🚻 部屋制限", bStyle("genderRoleEnabled")), createBtn("config_messages", "💬 メッセージ", ButtonStyle.Secondary), createBtn("cfg_btn_raw", "📄 データ", ButtonStyle.Primary)]),
      createRow([createBtn("cfg_btn_restart", "🔄 ボット再起動", ButtonStyle.Danger), createBtn("cfg_btn_refresh", "♻️ パネル再送", ButtonStyle.Secondary)])
    ];
  } else {
    const configs = {
      afk: { title: "💤 AFK (寝落ち) 設定", desc: `- 💤 移動先: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}`, feature: "afkEnabled", toggle: "toggle_afk", label: "AFK機能", select: { id: "select_cfg_afk", ph: "💤 移動先を選択", type: [ChannelType.GuildVoice] } },
      panel: { title: "🛠️ VC作成パネル設定", desc: `- 🛠️ 設置先: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}`, feature: "vcPanelEnabled", toggle: "toggle_panel", label: "パネル機能", select: { id: "select_cfg_panel", ph: "🛠️ 設置先を選択", type: [ChannelType.GuildText] } },
      trigger: {
        title: "➕ VC自動作成設定",
        desc: `- 自由枠 ─ ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定`"} (\`${dynamicVC.channelName}\`)\n- 4人部屋 ─ ${dynamicVC.triggerChannelId4 ? `<#${dynamicVC.triggerChannelId4}>` : "`未設定`"} (\`${dynamicVC.channelName4 || "雑談4人部屋"}\`)\n- 5人部屋 ─ ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"} (\`${dynamicVC.channelName5 || "雑談5人部屋"}\`)`,
        feature: "vcCreationEnabled", toggle: "toggle_vc_creation", label: "自動作成機能",
        extraBtn: createBtn("config_trigger_names", "📛 部屋名設定", ButtonStyle.Primary),
        selects: [
          { id: "select_cfg_trigger", ph: "➕ 自由枠トリガーを選択", type: [ChannelType.GuildVoice] },
          { id: "select_cfg_trigger4", ph: "👥 4人部屋トリガーを選択", type: [ChannelType.GuildVoice] },
          { id: "select_cfg_trigger5", ph: "👥 5人部屋トリガーを選択", type: [ChannelType.GuildVoice] }
        ]
      },
      intro_kick: { title: "📝 未提出者自動整理 設定", desc: `- 📝 提出確認: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n- ⚠️ 警告: ${dynamicVC.introWarnMinutes || 2880}分後\n- 🚪 キック: ${dynamicVC.introKickMinutes || 4320}分後`, feature: "introKickEnabled", toggle: "toggle_intro_kick", label: "自動整理", extraBtn: createBtn("config_intro_time", "⏱️ 期限設定", ButtonStyle.Primary), extraBtn2: createBtn("cfg_intro_restore", "🔄 チャンネルから復元", ButtonStyle.Secondary), select: { id: "select_cfg_introcheck", ph: "📝 提出確認用を選択", type: [ChannelType.GuildText] } },
      intro_display: { title: "🖼️ VC内自己紹介表示 設定", desc: `- 📋 ソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}`, feature: "vcIntroDisplayEnabled", toggle: "toggle_vc_intro", label: "VC内表示", extraBtn: createBtn("cfg_intro_restore", "🔄 チャンネルから復元", ButtonStyle.Secondary), select: { id: "select_cfg_introsource", ph: "📋 ソースを選択", type: [ChannelType.GuildText] } },
      vc: {
        title: "🚻 部屋制限 設定", desc: `- ♂️ 男性ロール: ${roles.male ? `<@&${roles.male}>` : "`未設定`"}\n- ♀️ 女性ロール: ${roles.female ? `<@&${roles.female}>` : "`未設定`"}`, feature: "genderRoleEnabled", toggle: "toggle_gender", label: "部屋制限", selects: [
          { id: "select_cfg_male", ph: "♂️ 男性ロールを選択", role: true },
          { id: "select_cfg_female", ph: "♀️ 女性ロールを選択", role: true }
        ]
      }
    }[type];

    const isEnabled = features[configs.feature];
    const statusLabel = isEnabled ? "` 🟢 有効 `" : "` 🔴 無効 `";
    const cleanedDesc = configs.desc.replace(/`未設定`/g, "`未設定` 🟥");
    embed.setTitle(configs.title).setDescription(`${statusLabel}\n\n${cleanedDesc}`);
    const row1Btns = [createBtn(configs.toggle, `${configs.label}: ${isEnabled ? "有効" : "無効"}`, isEnabled ? ButtonStyle.Success : ButtonStyle.Danger)];
    if (configs.extraBtn) row1Btns.push(configs.extraBtn.setDisabled(!isEnabled));
    if (configs.extraBtn2) row1Btns.push(configs.extraBtn2.setDisabled(!isEnabled));
    components.push(createRow(row1Btns));

    (configs.selects || [configs.select]).filter(Boolean).forEach(s => {
      const menu = s.role ? new RoleSelectMenuBuilder() : new ChannelSelectMenuBuilder().setChannelTypes(s.type);
      components.push(createRow([menu.setCustomId(s.id).setPlaceholder(isEnabled ? s.ph : "⛔ 無効なため設定不可").setDisabled(!isEnabled)]));
    });
    components.push(createRow([createBtn("cfg_back_main", "⬅️ 戻る")]));
  }
  return { embeds: [embed], components, ephemeral: true };
}

// ─── パネル更新 ──────────────────────────────────────────────────────────────
async function setupSettingsPanel(gid, config = null) {
  const g = config || await getGuildConfig(gid);
  const SETTINGS_CHANNEL_ID = g.dynamicVC?.createPanelChannelId || "1496141555705319445"; // fallback
  const channel = client.channels.cache.get(SETTINGS_CHANNEL_ID); if (!channel) return;
  try { 
    const msgs = await channel.messages.fetch({ limit: 50 }); 
    const toDelete = msgs.filter(m => m.author.id === client.user.id);
    if (toDelete.size > 0) {
      if (channel.type === ChannelType.GuildText) {
        await channel.bulkDelete(toDelete).catch(() => {
          // 2週間以上前のメッセージが含まれる場合は個別削除
          toDelete.forEach(async m => await m.delete().catch(() => { }));
        });
      } else {
        for (const m of toDelete.values()) await m.delete().catch(() => { });
      }
    }
  } catch (err) { console.error("パネル削除エラー:", err.message); }

  const meta = { version: (g.meta.version || 0) + 1, lastUpdated: new Date().toISOString() };
  await updateGuildConfig(gid, { $set: { meta } });

  const payload = await getSettingsPayload(gid, "main", g);
  payload.embeds[0].setFooter({ text: `Last Updated: ${new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` });
  await channel.send(payload);
}

async function setupCreatePanel(gid) {
  const g = await getGuildConfig(gid);
  const channelId = g.dynamicVC.createPanelChannelId; if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId); if (!channel) return;
    const msgs = await channel.messages.fetch({ limit: 20 }); for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
    const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle("🎙️ ボイスチャンネル作成").setDescription("作成したいVCのタイプを選択してください。\n-# 人数固定の部屋は、作成後に上限を変更できません。");
    const row = createRow([createBtn("create_vc_panel", "➕ 新規作成", ButtonStyle.Success), createBtn("create_vc_4", "👥 4人部屋", ButtonStyle.Secondary), createBtn("create_vc_5", "👥 5人部屋", ButtonStyle.Secondary)]);
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) { console.error(err.message); }
}

// ─── VCコントロールパネル ──────────────────────────────────────────────────────
async function buildPanelPayload(vc) {
  const g = await getGuildConfig(vc.guildId);
  const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, ownerId = vcOwners.get(vc.id), isFixed = limitLockedVCs.has(vc.id);
  const embed = new EmbedBuilder().setColor(locked ? 0xed4245 : 0x2b2d31).setTitle("🎙️ VC Control Interface").setDescription(`**部屋主** : <@${ownerId}>\n\n**現在の設定**\n- 状態: ${locked ? "🔒 ロック中" : "🔓 公開中"}\n- 上限: \`${limit === 0 ? "無制限" : limit + "人"}\`\n- 制限: \`${gender === "male" ? "♂️ 男性専用" : gender === "female" ? "♀️ 女性専用" : "なし"}\``);
  if (isFixed) return { embeds: [embed], components: [createRow([createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !g.features.afkEnabled)])] };
  const row1 = createRow([createBtn("vc_rename", "✏️ 名前変更"), createBtn("vc_toggle_lock", locked ? "🔓 解除" : "🔒 ロック", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 制限設定", ButtonStyle.Secondary, !g.features.genderRoleEnabled), createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !g.features.afkEnabled)]);
  return { embeds: [embed], components: locked ? [row1, createRow([createBtn(`vc_knock_${vc.id}`, "🚪 ノックして参加申請", ButtonStyle.Success)])] : [row1] };
}

async function buildVCSettingsPayload(vc) {
  const g = await getGuildConfig(vc.guildId);
  const gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = (n) => limit === n ? ButtonStyle.Success : ButtonStyle.Secondary;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle("🛡️ Room Restrictions").setDescription(`現在の設定\n- 上限: \`${limit === 0 ? "無制限" : limit + "人"}\`\n- 制限: \`${gender === "male" ? "♂️ 男性専用" : gender === "female" ? "♀️ 女性専用" : "なし"}\``);
  return { embeds: [embed], components: [createRow([createBtn("label_g", "【性別】", ButtonStyle.Secondary, true), createBtn("vc_gender_none", "なし", gStyle(null), !g.features.genderRoleEnabled), createBtn("vc_gender_male", "♂️ 男性", gStyle("male"), !g.features.genderRoleEnabled), createBtn("vc_gender_female", "♀️ 女性", gStyle("female"), !g.features.genderRoleEnabled)]), createRow([createBtn("label_l", "【人数】", ButtonStyle.Secondary, true), createBtn("vc_limit_0", "∞", lStyle(0)), createBtn("vc_limit_4", "4人", lStyle(4)), createBtn("vc_limit_5", "5人", lStyle(5)), createBtn("vc_limit_custom", "指定...", ButtonStyle.Primary)]), createRow([createBtn("vc_main_panel", "⬅️ 戻る")])] };
}

async function sendOrUpdateControlPanel(vc) {
  const oldId = controlPanelMsgIds.get(vc.id), payload = await buildPanelPayload(vc);
  if (oldId) try { await (await vc.messages.fetch(oldId)).edit(payload); return; } catch { }
  try { const s = await vc.send(payload); controlPanelMsgIds.set(vc.id, s.id); } catch { }
}

async function updateVcName(vc, newName) {
  const now = Date.now(), last = renameTimestamps.get(vc.id) || 0;
  if (now - last < 300000) return vc.send("⚠️ 部屋名の変更は5分に1回までです。しばらく待ってからやり直してください。").then(m => setTimeout(() => m.delete().catch(() => { }), 5000));
  try { await vc.setName(newName); renameTimestamps.set(vc.id, now); await sendOrUpdateControlPanel(vc); } catch (e) { console.error(e); }
}

async function updateKnockNotifyMessage(vc) {
  const pending = pendingRequests.get(vc.id), applicantIds = pending ? [...pending.keys()] : [];
  if (applicantIds.length === 0) { const id = knockNotifyMsgIds.get(vc.id); if (id) try { await (await vc.messages.fetch(id)).delete(); } catch { } knockNotifyMsgIds.delete(vc.id); return; }
  const embeds = [new EmbedBuilder().setColor(0xf39c12).setTitle("🚪 ノックされています"), ...applicantIds.map(uid => new EmbedBuilder().setColor(0xf39c12).setDescription(`<@${uid}> が入室しようとしています。`).setThumbnail(vc.guild.members.cache.get(uid)?.user.displayAvatarURL() || null))];
  const rows = applicantIds.slice(0, 5).map(uid => createRow([createBtn(`knock_approve_${vc.id}_${uid}`, "✨ 歓迎する", ButtonStyle.Success), createBtn(`knock_deny_${vc.id}_${uid}`, "🤝 お断りする", ButtonStyle.Danger)]));
  const id = knockNotifyMsgIds.get(vc.id); try { if (id) await (await vc.messages.fetch(id)).edit({ embeds, components: rows }); else { const s = await vc.send({ embeds, components: rows }); knockNotifyMsgIds.set(vc.id, s.id); } } catch { }
}

// ─── インタラクション ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (i) => {
  if (i.isChatInputCommand()) {
    const gid = i.guildId;
    if (i.commandName === "setup") {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: "管理者のみ実行可能です。", ephemeral: true });
      await updateGuildConfig(gid, { $set: { "dynamicVC.createPanelChannelId": i.channelId } });
      await i.reply({ content: "✅ このチャンネルを管理パネル設置先に設定しました。パネルを送信します...", ephemeral: true });
      return await setupSettingsPanel(gid);
    }
    const cmd = client.commands.get(i.commandName);
    if (cmd) cmd.execute(i).catch(console.error);
    return;
  }

  const gid = i.guildId;
  const g = await getGuildConfig(gid);

  if (i.isButton()) {
    const cid = i.customId;
    if (cid.startsWith("create_vc_")) {
      if (!g.features.vcPanelEnabled) return i.reply({ content: "無効です", ephemeral: true });
      const limit = cid === "create_vc_4" ? 4 : cid === "create_vc_5" ? 5 : 0;
      return i.showModal(new ModalBuilder().setCustomId(`create_vc_modal_${limit}`).setTitle("VC作成").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("名前").setStyle(TextInputStyle.Short).setValue(`${i.member.displayName}のVC`).setRequired(true)])));
    }
    if (cid === "vc_toggle_lock") {
      const vc = i.member.voice.channel; if (!vc || !tempChannels.has(vc.id) || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      lockedVCs.has(vc.id) ? lockedVCs.delete(vc.id) : lockedVCs.add(vc.id);
      return i.update(await buildPanelPayload(vc));
    }
    if (cid === "vc_settings_btn") { const vc = i.member.voice.channel; if (vc && tempChannels.has(vc.id) && vcOwners.get(vc.id) === i.user.id && g.features.genderRoleEnabled) return i.update(await buildVCSettingsPayload(vc)); return i.deferUpdate(); }
    if (cid === "vc_main_panel") { const vc = i.member.voice.channel; if (vc && tempChannels.has(vc.id)) return i.update(await buildPanelPayload(vc)); return i.deferUpdate(); }
    if (cid.startsWith("vc_gender_")) {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      const mode = cid.split("_")[2]; if (mode === "none") genderMode.delete(vc.id); else genderMode.set(vc.id, mode);
      await i.update(await buildVCSettingsPayload(vc));
      const overwrites = [{ id: vc.guild.roles.everyone.id, [mode ? 'deny' : 'allow']: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }];
      if (mode) overwrites.push({ id: g.roles[mode], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: g.roles[mode === 'male' ? 'female' : 'male'], deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
      return vc.permissionOverwrites.set(overwrites).catch(console.error);
    }
    if (cid.startsWith("vc_limit_") && cid !== "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: g.messages.limitLockedWarning, ephemeral: true });
      await vc.setUserLimit(parseInt(cid.split("_")[2])); return i.update(await buildVCSettingsPayload(vc));
    }
    if (cid === "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: g.messages.limitLockedWarning, ephemeral: true });
      return i.showModal(new ModalBuilder().setCustomId(`limit_modal_${vc.id}`).setTitle("上限設定").addComponents(createRow([new TextInputBuilder().setCustomId("limit").setLabel("人数(0-99)").setStyle(TextInputStyle.Short).setRequired(true)])));
    }
    if (cid === "vc_rename") { const vc = i.member.voice.channel; if (vc && vcOwners.get(vc.id) === i.user.id) return i.showModal(new ModalBuilder().setCustomId(`rename_modal_${vc.id}`).setTitle("名前変更").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("新しい名前").setStyle(TextInputStyle.Short).setRequired(true)]))); return i.deferUpdate(); }
    if (cid === "vc_afk_prompt") {
      if (!g.features.afkEnabled) return i.reply({ content: "無効", ephemeral: true });
      const vc = i.member.voice.channel; if (!vc || vc.id !== i.channelId) return i.reply({ content: "このVCに参加中のみ可", ephemeral: true });
      return i.reply({ content: "移動させる人を選択", components: [createRow([new UserSelectMenuBuilder().setCustomId(`vc_afk_select_${vc.id}`).setPlaceholder("選択").setMaxValues(1)])], ephemeral: true });
    }
    if (cid === "cfg_back_main") return i.update(await getSettingsPayload(gid, "main", g));
    if (cid === "cfg_btn_raw") {
      const json = JSON.stringify(g, null, 2);
      return i.reply({ content: `### 📂 データベース内の生データ\n\`\`\`json\n${json.length > 1900 ? json.substring(0, 1900) + "...(省略)" : json}\n\`\`\``, ephemeral: true });
    }
    if (cid === "cfg_btn_restart") {
      await i.reply({ content: "🔄 ボットを再起動します... (数秒後に復帰します)", ephemeral: true });
      console.log("🚀 User requested restart. Exiting...");
      process.exit(0);
    }
    if (cid === "cfg_btn_refresh") {
      await i.reply({ content: "♻️ パネルを再送信しています...", ephemeral: true });
      await setupSettingsPanel(gid, g);
      await setupCreatePanel(gid);
      return;
    }
    if (cid === "cfg_intro_restore") {
      await i.reply({ content: "⏳ チャンネル内のメッセージをスキャンして復元を開始します...", ephemeral: true });
      let statusCount = 0, contentCount = 0;
      const scan = async (cid, isSource) => {
        const ch = i.guild.channels.cache.get(cid); if (!ch || !ch.isTextBased()) return;
        let lastId = null;
        while (true) {
          const msgs = await ch.messages.fetch({ limit: 100, before: lastId }); if (msgs.size === 0) break;
          for (const m of msgs.values()) {
            if (m.author.bot) continue;
            const data = isSource ? { content: (m.content + (m.attachments.size ? "\n" + m.attachments.map(a => a.url).join("\n") : "")).trim() } : { introduced: true };
            await Intro.findOneAndUpdate({ guildId: gid, userId: m.author.id }, { $set: data }, { upsert: true });
            if (isSource) contentCount++; else statusCount++;
          }
          lastId = msgs.lastKey();
        }
      };
      if (g.dynamicVC.introCheckChannelId) await scan(g.dynamicVC.introCheckChannelId, false);
      if (g.dynamicVC.introSourceChannelId) await scan(g.dynamicVC.introSourceChannelId, true);
      return i.followUp({ content: `✅ 復元が完了しました！\n- 提出ステータス: ${statusCount} 件\n- 自己紹介本文: ${contentCount} 件\nをデータベースに保存しました。`, ephemeral: true });
    }
    if (cid.startsWith("cfg_btn_")) return i.update(await getSettingsPayload(gid, cid.replace("cfg_btn_", ""), g));

    const toggles = { toggle_afk: "afkEnabled", toggle_panel: "vcPanelEnabled", toggle_vc_creation: "vcCreationEnabled", toggle_intro_kick: "introKickEnabled", toggle_vc_intro: "vcIntroDisplayEnabled", toggle_gender: "genderRoleEnabled" };
    if (toggles[cid]) {
      const key = toggles[cid];
      const newFeatures = { ...g.features, [key]: !g.features[key] };
      const nextType = cid.replace("toggle_", "").replace("gender", "vc").replace("vc_creation", "trigger").replace("vc_intro", "intro_display");
      await updateGuildConfig(gid, { $set: { features: newFeatures } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, nextType, updatedG));
      await setupSettingsPanel(gid, updatedG);
    }

    if (cid === "config_intro_time") return i.showModal(new ModalBuilder().setCustomId("intro_time_modal").setTitle("期限設定").addComponents(createRow([new TextInputBuilder().setCustomId("warn").setLabel("警告(分)").setStyle(TextInputStyle.Short).setValue(String(g.dynamicVC.introWarnMinutes || 2880))]), createRow([new TextInputBuilder().setCustomId("kick").setLabel("キック(分)").setStyle(TextInputStyle.Short).setValue(String(g.dynamicVC.introKickMinutes || 4320))])));
    if (cid === "config_trigger_names") return i.showModal(new ModalBuilder().setCustomId("trigger_name_modal").setTitle("部屋名テンプレート設定").addComponents(
      createRow([new TextInputBuilder().setCustomId("name_free").setLabel("自由枠 ({user}使用可)").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.channelName || "{user}のVC").setRequired(true)]),
      createRow([new TextInputBuilder().setCustomId("name4").setLabel("4人部屋").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.channelName4 || "雑談4人部屋").setRequired(true)]),
      createRow([new TextInputBuilder().setCustomId("name5").setLabel("5人部屋").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.channelName5 || "雑談5人部屋").setRequired(true)])
    ));
    if (cid === "config_messages") return i.reply({ content: "編集カテゴリ選択", components: [createRow([createBtn("msg_modal_intro", "自己紹介関連", ButtonStyle.Primary), createBtn("msg_modal_vc", "VC関連", ButtonStyle.Primary)])], ephemeral: true });
    if (cid.startsWith("msg_modal_")) {
      const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"], labels = isIntro ? ["確認通知", "期限警告", "未記入キックDM"] : ["上限固定エラー", "男性専用エラーDM", "女性専用エラーDM"];
      return i.showModal(new ModalBuilder().setCustomId(`msg_submit_${isIntro ? 'intro' : 'vc'}`).setTitle("メッセージ編集").addComponents(keys.map((k, j) => createRow([new TextInputBuilder().setCustomId(k).setLabel(labels[j]).setStyle(TextInputStyle.Paragraph).setValue((g.messages[k] || "").replace(/\\n/g, '\n'))]))));
    }
    if (cid.startsWith("vc_knock_")) {
      const vcId = cid.replace("vc_knock_", ""), vc = i.guild.channels.cache.get(vcId); if (!vc || i.member.voice.channelId === vcId || vcOwners.get(vcId) === i.user.id || !lockedVCs.has(vcId)) return i.deferUpdate();
      if (!pendingRequests.has(vcId)) pendingRequests.set(vcId, new Map()); pendingRequests.get(vcId).set(i.user.id, true); await updateKnockNotifyMessage(vc); return i.reply({ content: "✅ 申請しました", ephemeral: true });
    }
    if (cid.startsWith("knock_approve_") || cid.startsWith("knock_deny_")) {
      const [, , vcId, uid] = cid.split("_"), vc = i.guild.channels.cache.get(vcId); if (!vc || vcOwners.get(vcId) !== i.user.id) return i.deferUpdate();
      await (i.channel.type === ChannelType.DM ? i.update({ content: `✅ ${cid.includes("approve") ? "歓迎" : "お断り"}しました。`, components: [] }) : i.deferUpdate());
      pendingRequests.get(vcId)?.delete(uid);
      if (cid.includes("approve")) { if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set()); allowedUsers.get(vcId).add(uid); const m = await i.guild.members.fetch(uid).catch(() => null); if (m?.voice.channel) m.voice.setChannel(vc).catch(() => vc.send(`✨ <@${uid}> さん、どうぞお入りください！`)); else vc.send(`✨ <@${uid}> さん、どうぞお入りください！`).then(msg => setTimeout(() => msg.delete().catch(() => { }), 60000)); }
      return updateKnockNotifyMessage(vc);
    }
    if (cid.startsWith("role_assign_")) {
      const [, , uid, mode] = cid.split("_"), member = await i.guild.members.fetch(uid).catch(() => null);
      if (!member) return i.update({ content: "❌ ユーザーが見つかりませんでした。", components: [] });
      if (mode === "none") return i.update({ content: "✅ お断りしました。", components: [] });
      try { const roleId = g.roles[mode]; if (roleId) await member.roles.add(roleId); await i.update({ content: `✅ <@${uid}> を ${mode === 'male' ? '男性' : '女性'}グループに追加しました！`, components: [] }); } catch (e) { await i.update({ content: `❌ エラー: ${e.message}`, components: [] }); }
    }
  }

  if (i.isModalSubmit()) {
    const cid = i.customId;
    if (cid.startsWith("create_vc_modal_")) {
      const name = i.fields.getTextInputValue("name"), limit = parseInt(cid.split("_")[3]); await silentReply(i);
      try { const vc = await i.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: g.dynamicVC?.cleanupCategoryId, userLimit: limit, permissionOverwrites: [{ id: i.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] }); tempChannels.add(vc.id); vcOwners.set(vc.id, i.user.id); if (limit) limitLockedVCs.add(vc.id); await sendOrUpdateControlPanel(vc); } catch { }
    }
    if (cid.startsWith("limit_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("limit_modal_", "")), val = parseInt(i.fields.getTextInputValue("limit")); await silentReply(i); if (vc && !isNaN(val)) { await vc.setUserLimit(val); await sendOrUpdateControlPanel(vc); } }
    if (cid.startsWith("rename_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("rename_modal_", "")); await silentReply(i); if (vc) await updateVcName(vc, i.fields.getTextInputValue("name").trim()); }
    if (cid === "intro_time_modal") {
      const w = parseInt(i.fields.getTextInputValue("warn")), k = parseInt(i.fields.getTextInputValue("kick"));
      if (!isNaN(w) && !isNaN(k)) {
        await updateGuildConfig(gid, { $set: { "dynamicVC.introWarnMinutes": w, "dynamicVC.introKickMinutes": k } });
        const updatedG = await getGuildConfig(gid, true);
        await i.update(await getSettingsPayload(gid, "intro_kick", updatedG));
        await setupSettingsPanel(gid, updatedG);
      }
    }
    if (cid === "trigger_name_modal") {
      const nf = i.fields.getTextInputValue("name_free"), n4 = i.fields.getTextInputValue("name4"), n5 = i.fields.getTextInputValue("name5");
      await updateGuildConfig(gid, { $set: { "dynamicVC.channelName": nf, "dynamicVC.channelName4": n4, "dynamicVC.channelName5": n5 } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "trigger", updatedG));
      await setupSettingsPanel(gid, updatedG);
    }
    if (cid.startsWith("msg_submit_")) {
      const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];
      const newMsgs = { ...g.messages }; keys.forEach(k => { newMsgs[k] = i.fields.getTextInputValue(k).replace(/\n/g, '\\n'); });
      await updateGuildConfig(gid, { $set: { messages: newMsgs } });
      return i.reply({ content: "✅ 更新完了", ephemeral: true });
    }
  }

  if (i.isAnySelectMenu()) {
    if (i.customId.startsWith("vc_afk_select_")) {
      const targetUid = i.values[0];
      const member = await i.guild.members.fetch(targetUid).catch(() => null);
      if (!member || !member.voice.channelId) return i.reply({ content: "ユーザーがボイスチャンネルにいません。", ephemeral: true });
      if (!g.dynamicVC.afkChannelId) return i.reply({ content: "AFKチャンネルが設定されていません。", ephemeral: true });
      try {
        await member.voice.setChannel(g.dynamicVC.afkChannelId);
        return i.reply({ content: `✅ <@${targetUid}> をお布団へ運びました。`, ephemeral: true });
      } catch (e) {
        return i.reply({ content: `❌ 移動に失敗しました: ${e.message}`, ephemeral: true });
      }
    }

    if (i.customId.startsWith("select_cfg_")) {
      const field = i.customId.replace("select_cfg_", ""), val = i.values[0];
      const map = { trigger: "triggerChannelId", trigger4: "triggerChannelId4", trigger5: "triggerChannelId5", afk: "afkChannelId", panel: "createPanelChannelId", introcheck: "introCheckChannelId", introsource: "introSourceChannelId" };
      const typeMap = { trigger: "trigger", trigger4: "trigger", trigger5: "trigger", afk: "afk", panel: "panel", introcheck: "intro_kick", introsource: "intro_display" };
      const type = typeMap[field] || "vc";
      if (map[field]) await updateGuildConfig(gid, { $set: { [`dynamicVC.${map[field]}`]: val } });
      else await updateGuildConfig(gid, { $set: { [`roles.${field}`]: val } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, type, updatedG));
      await setupSettingsPanel(gid, updatedG); if (field === "panel") await setupCreatePanel(gid);
    }
  }
});

// ─── VoiceStateUpdate ─────────────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (o, n) => {
  const gid = n.guild.id;
  const g = await getGuildConfig(gid);
  const triggers = [g.dynamicVC.triggerChannelId, g.dynamicVC.triggerChannelId4, g.dynamicVC.triggerChannelId5];

  if (n.channelId && triggers.includes(n.channelId) && g.features.vcCreationEnabled) {
    const limit = n.channelId === triggers[1] ? 4 : n.channelId === triggers[2] ? 5 : 0;
    const name = limit === 4 ? (g.dynamicVC.channelName4 || "雑談4人部屋") : limit === 5 ? (g.dynamicVC.channelName5 || "雑談5人部屋") : g.dynamicVC.channelName.replace("{user}", n.member.displayName);
    try { const vc = await n.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: n.channel.parentId, userLimit: limit, permissionOverwrites: [{ id: n.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }] }); tempChannels.add(vc.id); vcOwners.set(vc.id, n.member.id); if (limit) limitLockedVCs.add(vc.id); await n.member.voice.setChannel(vc); await sendOrUpdateControlPanel(vc); } catch { }
    return;
  }
  if (n.channelId && tempChannels.has(n.channelId)) {
    const vc = n.channel, m = n.member, gender = genderMode.get(vc.id);
    if (g.features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== m.id && !m.roles.cache.has(g.roles[gender])) {
      try { await m.voice.disconnect(); m.send((g.messages[gender === 'male' ? 'genderMaleOnlyDM' : 'genderFemaleOnlyDM'] || "").replace(/{vcName}/g, vc.name).replace(/\\n/g, '\n')).catch(() => { }); } catch { } return;
    }
    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== m.id && !allowedUsers.get(vc.id)?.has(m.id)) { try { await m.voice.disconnect(); } catch { } return; }
    if (o.channelId !== n.channelId && g.features.vcIntroDisplayEnabled) {
      const bio = await Intro.findOne({ guildId: gid, userId: m.id });
      if (bio?.content) { if (!introPosted.has(vc.id)) introPosted.set(vc.id, new Set()); if (!introPosted.get(vc.id).has(m.id)) { introPosted.get(vc.id).add(m.id); const msg = await vc.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setThumbnail(m.user.displayAvatarURL()).setDescription(`### ${m.displayName}\n\n${bio.content}`)] }).catch(() => null); if (msg) introMsgIds.set(`${vc.id}_${m.id}`, msg.id); } }
    }
  }
  if (o.channelId && tempChannels.has(o.channelId) && o.channelId !== n.channelId) {
    const ch = o.channel, key = `${o.channelId}_${o.member.id}`; if (introMsgIds.has(key)) { try { await (await ch.messages.fetch(introMsgIds.get(key))).delete(); } catch { } introMsgIds.delete(key); introPosted.get(o.channelId)?.delete(o.member.id); }
    if (ch?.members.size === 0) { try { await ch.delete();[tempChannels, controlPanelMsgIds, lockedVCs, genderMode, vcOwners, pendingRequests, allowedUsers, knockNotifyMsgIds, renameTimestamps, introPosted, limitLockedVCs].forEach(s => s.delete(o.channelId)); } catch { } }
    else if (ch && vcOwners.get(ch.id) === o.member.id) { const next = ch.members.first(); if (next) { vcOwners.set(ch.id, next.id); await sendOrUpdateControlPanel(ch); } }
  }
});

// ─── 自己紹介管理 ──────────────────────────────────────────────────────────
async function syncIntroHistory(gid) {
  const g = await getGuildConfig(gid);
  const checkChId = g.dynamicVC.introCheckChannelId, sourceChId = g.dynamicVC.introSourceChannelId;
  const guild = client.guilds.cache.get(gid); if (!guild) return;

  const scan = async (cid, isSource) => {
    const ch = guild.channels.cache.get(cid); if (!ch || !ch.isTextBased()) return;
    let lastId = null;
    while (true) {
      try {
        const msgs = await ch.messages.fetch({ limit: 100, before: lastId }); if (msgs.size === 0) break;
        for (const m of msgs.values()) {
          if (m.author.bot) continue;
          const data = isSource ? { content: (m.content + (m.attachments.size ? "\n" + m.attachments.map(a => a.url).join("\n") : "")).trim() } : { introduced: true };
          await Intro.findOneAndUpdate({ guildId: gid, userId: m.author.id }, { $set: data }, { upsert: true });
        }
        lastId = msgs.lastKey();
      } catch { break; }
    }
  };
  if (checkChId) await scan(checkChId, false);
  if (sourceChId) await scan(sourceChId, true);
  console.log(`🔄 Guild ${gid}: チャンネル履歴からの同期が完了しました。`);
}

const handleIntroUpdate = async (msg, type = "create") => {
  if (msg.author?.bot) return;
  const gid = msg.guildId; if (!gid) return;
  const g = await getGuildConfig(gid);
  const checkCh = g.dynamicVC.introCheckChannelId, sourceCh = g.dynamicVC.introSourceChannelId;
  if (![checkCh, sourceCh].includes(msg.channelId)) return;

  const isDel = type === "delete", uid = msg.author.id;
  if (isDel) {
    if (msg.channelId === sourceCh) await Intro.updateOne({ guildId: gid, userId: uid }, { $set: { content: "" } });
  } else {
    const introData = { guildId: gid, userId: uid };
    if (msg.channelId === checkCh) introData.introduced = true;
    if (msg.channelId === sourceCh) introData.content = (msg.content + (msg.attachments.size ? "\n" + msg.attachments.map(a => a.url).join("\n") : "")).trim();
    const bio = await updateIntro(gid, uid, introData);
    if (type === "create" && msg.channelId === checkCh) {
      if (bio.warnMsgId) { try { await (await msg.guild.channels.cache.get(checkCh).messages.fetch(bio.warnMsgId)).delete(); } catch { } await Intro.updateOne({ _id: bio._id }, { $set: { warnMsgId: null } }); }
      msg.reply({ content: (g.messages.introNotify || "✅ 確認").replace(/{user}/g, uid).replace(/\\n/g, '\n') }).then(r => setTimeout(() => r.delete().catch(() => { }), 10000));
    }
  }
};

client.on(Events.MessageCreate, m => handleIntroUpdate(m, "create"));
client.on(Events.MessageUpdate, (o, n) => handleIntroUpdate(n, "update"));
client.on(Events.MessageDelete, m => handleIntroUpdate(m, "delete"));

// ─── 起動処理 ────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  
  // スラッシュコマンドの登録 (全サーバー一括)
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("📝 スラッシュコマンドを登録中...");
    const commandsData = allCommands.map(c => c.data.toJSON());
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandsData });
    console.log("✅ スラッシュコマンドの登録が完了しました。");
  } catch (err) { console.error("❌ コマンド登録エラー:", err); }

  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    const gid = guild.id;
    const g = await getGuildConfig(gid);
    await setupSettingsPanel(gid);
    await setupCreatePanel(gid);
    await syncIntroHistory(gid);

    // データ移行 (introDB.json -> MongoDB)
    if (fs.existsSync("./introDB.json")) {
      try {
        const localIntro = JSON.parse(fs.readFileSync("./introDB.json", "utf-8"));
        let migratedCount = 0;
        if (localIntro[gid]) {
          for (const [uid, data] of Object.entries(localIntro[gid])) {
            if (typeof data === "object") {
              const existing = await Intro.findOne({ guildId: gid, userId: uid });
              if (!existing) { await Intro.create({ guildId: gid, userId: uid, ...data }); migratedCount++; }
            }
          }
        }
        if (gid === guildId) {
          for (const [uid, data] of Object.entries(localIntro)) {
            if (uid.length > 15 && typeof data === "object" && !localIntro[uid]) {
              const existing = await Intro.findOne({ guildId: gid, userId: uid });
              if (!existing) { await Intro.create({ guildId: gid, userId: uid, ...data }); migratedCount++; }
            }
          }
        }
        if (migratedCount > 0) console.log(`📦 Guild ${gid}: ${migratedCount} 件の自己紹介データを移行しました。`);
      } catch (err) { console.error("❌ 自己紹介データ移行エラー:", err); }
    }

    // 定期チェック (自己紹介キック)
    setInterval(async () => {
      const gCurrent = await getGuildConfig(guild.id);
      if (!gCurrent.features.introKickEnabled) return;
      const members = await guild.members.fetch();
      const now = Date.now();
      for (const m of members.values()) {
        if (m.user.bot) continue;
        const bio = await Intro.findOne({ guildId: guild.id, userId: m.id });
        if (bio?.introduced) continue;
        const elapsed = now - m.joinedTimestamp, warn = (gCurrent.dynamicVC.introWarnMinutes || 2880) * 60000, kick = (gCurrent.dynamicVC.introKickMinutes || 4320) * 60000;
        if (elapsed >= kick) { try { await m.send(gCurrent.messages.introKickDM.replace(/\\n/g, '\n')); } catch { } await m.kick("未記入"); await Intro.updateOne({ guildId: guild.id, userId: m.id }, { $set: { kicked: true } }, { upsert: true }); }
        else if (elapsed >= warn && !bio?.warned) {
          const w = await guild.channels.cache.get(gCurrent.dynamicVC.introCheckChannelId).send(gCurrent.messages.introWarnMsg.replace(/{user}/g, m.id).replace(/{leftMinutes}/g, Math.floor((kick - elapsed) / 60000)).replace(/\\n/g, '\n'));
          await updateIntro(guild.id, m.id, { warned: true, warnMsgId: w.id });
          setTimeout(() => w.delete().catch(() => { }), kick - elapsed);
        }
      }
    }, 60000);
  }
});

client.login(token);
