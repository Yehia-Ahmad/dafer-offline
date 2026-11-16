// Shared helpers for the server CLI scripts (create-owner, recover-owner).
const readline = require("node:readline");

/** --key value / --key=value pairs. */
const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    out[match[1]] = match[2] !== undefined ? match[2] : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "";
  }
  return out;
};

/** Asks for a secret on the terminal without echoing it. */
const askHidden = (question) =>
  new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("The password is asked on the terminal; run this script from an interactive shell."));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });

const askNewPassword = async () => {
  const password = await askHidden("Password: ");
  const again = await askHidden("Repeat password: ");
  if (password !== again) throw new Error("The two passwords do not match.");
  return password;
};

module.exports = { parseArgs, askHidden, askNewPassword };
