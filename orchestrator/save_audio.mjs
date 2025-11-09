import fs from "fs";

let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  const json = JSON.parse(data);
  const audio = Buffer.from(json.audioBase64, "base64");
  fs.writeFileSync("out.mp3", audio);
  console.log("✅ saved out.mp3 — play it to hear the response");
});
