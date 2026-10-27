import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import nodemailer from "nodemailer";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, ".env");
async function promptSender() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Gmail address to send verification codes from: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function readExistingPassword() {
  try {
    const text = await readFile(ENV_PATH, "utf8");
    const match = text.match(/^SMTP_APP_PASSWORD\s*=\s*(.*)$/m);
    return match ? match[1].trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, "") : "";
  } catch {
    return "";
  }
}

function promptSecret(message) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(message, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(message);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          reject(new Error("CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          process.stdout.write("*");
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

async function main() {
  const existingPassword = await readExistingPassword();
  if (process.argv.includes("--if-needed") && existingPassword) return;

  console.log("\nBRITEBIN CUSTOMERVISION — EMAIL SETUP\n");
  const sender = await promptSender();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
    console.error("Enter a valid sender email address and run setup again.");
    process.exitCode = 1;
    return;
  }
  console.log(`Verification codes will be sent from ${sender}.`);
  console.log("Use a Google app password, not the normal Gmail password.");
  console.log("Google account page: https://myaccount.google.com/apppasswords");
  console.log("Two-Step Verification must be enabled. A Workspace administrator may need to allow app passwords.\n");

  let appPassword;
  try {
    appPassword = (await promptSecret("Paste the 16-character Google app password: ")).replace(/\s+/g, "");
  } catch {
    console.error("Email setup was cancelled.");
    process.exitCode = 1;
    return;
  }

  if (appPassword.length < 16) {
    console.error("That does not look like a complete Google app password. Run the setup again.");
    process.exitCode = 1;
    return;
  }

  console.log("Checking the Gmail connection…");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: sender, pass: appPassword },
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  try {
    await transport.verify();
  } catch (error) {
    console.error(`Gmail did not accept the setup (${error?.code || "connection error"}).`);
    console.error("Check that the app password belongs to the entered sender address and try again.");
    process.exitCode = 1;
    return;
  }

  const content = [
    "# Local CustomerVision email settings. Do not share this file.",
    "SMTP_HOST=smtp.gmail.com",
    "SMTP_PORT=465",
    "SMTP_SECURE=true",
    `SMTP_USER=${sender}`,
    `SMTP_APP_PASSWORD=${appPassword}`,
    `SMTP_FROM=BriteBin CustomerVision <${sender}>`,
    "",
  ].join("\n");

  await writeFile(ENV_PATH, content, { encoding: "utf8", mode: 0o600 });
  console.log("Email verification is configured successfully.\n");
}

await main();
