const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const queues = new Map();

async function playSong(guildId, song) {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (!song) {
    try { if (queue.connection && queue.connection.state.status !== 'destroyed') queue.connection.destroy(); } catch(e){}
    queues.delete(guildId);
    return;
  }
  
  try {
    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    queue.player.play(resource);
    queue.playing = true;
    queue.textChannel.send({ content: `🎶 再生開始: **${song.title}**` }).catch(() => {});
  } catch (error) {
    console.error("再生エラー:", error);
    queue.textChannel.send({ content: `❌ 再生エラー: ${song.title}` }).catch(() => {});
    queue.songs.shift();
    playSong(guildId, queue.songs[0]);
  }
}

const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('音楽を再生します')
    .addStringOption(option => option.setName('query').setDescription('検索キーワードまたはURL').setRequired(true)),
  async execute(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');
    const voiceChannel = interaction.member.voice.channel;
    
    if (!voiceChannel) {
      return interaction.editReply('❌ ボイスチャンネルに参加してから実行してください。');
    }
    
    let songInfo;
    try {
      if (query.startsWith('http')) {
        const info = await play.video_info(query);
        songInfo = { title: info.video_details.title, url: info.video_details.url };
      } else {
        const searchResults = await play.search(query, { limit: 1 });
        if (!searchResults.length) {
          return interaction.editReply('❌ 検索結果が見つかりませんでした。');
        }
        songInfo = { title: searchResults[0].title, url: searchResults[0].url };
      }
    } catch (e) {
      return interaction.editReply('❌ 動画の取得に失敗しました。');
    }
    
    let queue = queues.get(interaction.guildId);
    
    if (!queue) {
      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
      });
      
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator
      });
      
      queue = {
        textChannel: interaction.channel,
        voiceChannel,
        connection,
        player,
        songs: [songInfo],
        playing: false
      };
      
      queues.set(interaction.guildId, queue);
      queue.connection.subscribe(queue.player);
      
      queue.player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        playSong(interaction.guildId, queue.songs[0]);
      });

      queue.player.on('error', error => {
         console.error('Player Error:', error.message);
         queue.songs.shift();
         playSong(interaction.guildId, queue.songs[0]);
      });
      
      playSong(interaction.guildId, queue.songs[0]);
      await interaction.editReply(`✅ キューに追加し、再生を開始します: **${songInfo.title}**`);
    } else {
      queue.songs.push(songInfo);
      await interaction.editReply(`✅ キューに追加しました: **${songInfo.title}**`);
    }
  }
};

const skipCommand = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('現在の曲をスキップします'),
  async execute(interaction) {
    const queue = queues.get(interaction.guildId);
    if (!queue) return interaction.reply({ content: '❌ 再生中の曲がありません。', ephemeral: true });
    queue.player.stop();
    await interaction.reply('⏭️ 曲をスキップしました。');
  }
};

const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('再生を停止し、ボイスチャンネルから退出します'),
  async execute(interaction) {
    const queue = queues.get(interaction.guildId);
    if (!queue) return interaction.reply({ content: '❌ 再生中の曲がありません。', ephemeral: true });
    queue.songs = [];
    queue.player.stop();
    try { if (queue.connection && queue.connection.state.status !== 'destroyed') queue.connection.destroy(); } catch(e){}
    queues.delete(interaction.guildId);
    await interaction.reply('⏹️ 再生を停止し、退出しました。');
  }
};

const queueCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('現在の再生待ちリストを表示します'),
  async execute(interaction) {
    const queue = queues.get(interaction.guildId);
    if (!queue || queue.songs.length === 0) return interaction.reply('❌ 再生待ちの曲がありません。');
    
    let text = '**🎶 現在のキュー:**\n';
    queue.songs.slice(0, 10).forEach((song, i) => {
      text += `${i === 0 ? '▶️' : i + 1 + '.'} ${song.title}\n`;
    });
    if (queue.songs.length > 10) text += `...他 ${queue.songs.length - 10} 曲`;
    
    await interaction.reply({ content: text });
  }
};

const commands = [playCommand, skipCommand, stopCommand, queueCommand];

// Button / Modal Helpers
async function handlePlayModal(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const query = interaction.fields.getTextInputValue('query');
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) return interaction.editReply('❌ ボイスチャンネルに参加してから実行してください。');

  let songInfo;
  try {
    if (query.startsWith('http')) {
      const info = await play.video_info(query);
      songInfo = { title: info.video_details.title, url: info.video_details.url };
    } else {
      const searchResults = await play.search(query, { limit: 1 });
      if (!searchResults.length) return interaction.editReply('❌ 検索結果が見つかりませんでした。');
      songInfo = { title: searchResults[0].title, url: searchResults[0].url };
    }
  } catch (e) {
    return interaction.editReply('❌ 動画の取得に失敗しました。');
  }

  let queue = queues.get(interaction.guildId);
  if (!queue) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator });
    queue = { textChannel: interaction.channel, voiceChannel, connection, player, songs: [songInfo], playing: false };
    queues.set(interaction.guildId, queue);
    queue.connection.subscribe(queue.player);
    queue.player.on(AudioPlayerStatus.Idle, () => { queue.songs.shift(); playSong(interaction.guildId, queue.songs[0]); });
    queue.player.on('error', error => { console.error('Player Error:', error.message); queue.songs.shift(); playSong(interaction.guildId, queue.songs[0]); });
    playSong(interaction.guildId, queue.songs[0]);
    await interaction.editReply(`✅ キューに追加し、再生を開始します: **${songInfo.title}**`);
  } else {
    queue.songs.push(songInfo);
    await interaction.editReply(`✅ キューに追加しました: **${songInfo.title}**`);
  }
}

async function skipFromButton(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) return interaction.reply({ content: '❌ 再生中の曲がありません。', ephemeral: true });
  queue.player.stop();
  await interaction.reply({ content: '⏭️ 曲をスキップしました。', ephemeral: true });
}

async function stopFromButton(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue) return interaction.reply({ content: '❌ 再生中の曲がありません。', ephemeral: true });
  queue.songs = [];
  queue.player.stop();
  try { if (queue.connection && queue.connection.state.status !== 'destroyed') queue.connection.destroy(); } catch(e){}
  queues.delete(interaction.guildId);
  await interaction.reply({ content: '⏹️ 再生を停止し、退出しました。', ephemeral: true });
}

async function queueFromButton(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.songs.length === 0) return interaction.reply({ content: '❌ 再生待ちの曲がありません。', ephemeral: true });
  let text = '**🎶 現在のキュー:**\n';
  queue.songs.slice(0, 10).forEach((song, i) => { text += `${i === 0 ? '▶️' : i + 1 + '.'} ${song.title}\n`; });
  if (queue.songs.length > 10) text += `...他 ${queue.songs.length - 10} 曲`;
  await interaction.reply({ content: text, ephemeral: true });
}

module.exports = { commands, handlePlayModal, skipFromButton, stopFromButton, queueFromButton };
