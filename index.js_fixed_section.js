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

  const on = "🟢";
  const off = "🔴";

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
      `- 👥 **5人部屋トリガー** : ${dynamicVC.triggerChannelId5 ? `<#${dynamicVC.triggerChannelId5}>` : "`未設定`"}\n\n" +

      `### 📝 自己紹介機能\n` +
      `${features.introKickEnabled ? "🟢" : "🔴"} **自動キック機能**\n` +
      `${features.vcIntroDisplayEnabled ? "🟢" : "🔴"} **VC内自己紹介表示**\n` +
      `- 📝 **期限確認** : ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n` +
      `- 📋 **VC表示用** : ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定`"}\n` +
      `- ⚠️ **警告/🚪キック**: \`${dynamicVC.introWarnMinutes ?? 2880}\`分 / \`${dynamicVC.introKickMinutes ?? 4320}\`分後\n\n` +

      `### 🚻 VC機能\n` +
      `${features.genderRoleEnabled ? "🟢" : "🔴"} **性別制限機能**\n` +
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
