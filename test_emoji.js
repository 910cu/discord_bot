const text = "Hello 👋 <:custom:123456789> World 🌍! 👍";
const cleaned = text.replace(/<a?:.+?:\d+>|\p{Extended_Pictographic}/gu, "");
console.log(cleaned);
