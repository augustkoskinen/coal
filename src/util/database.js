import {
  ChannelType,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
} from "discord.js";
import papaparse from "papaparse";
import { client } from "strife.js";
import { extractMessageExtremities, getAllMessages } from "./discord.js";
import config from "./config.js";
let timeouts = {};

const threadName = "databases";
export const databaseThread =
  (await config.channels.modlogs.threads.fetch()).threads.find(
    (thread) => thread.name === threadName
  ) ??
  (await config.channels.modlogs.threads.create({
    name: threadName,
    reason: "For databases",
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  }));

const databases = {};
export const allDatabaseMessages = await getAllMessages(databaseThread);
for (const message of allDatabaseMessages) {
  const name = message.content.split(" ")[1]?.toLowerCase();
  if (name) {
    databases[name] =
      message.author.id === client.user.id
        ? message
        : message.attachments.size
        ? await databaseThread.send({
            ...extractMessageExtremities(message),
            content: message.content,
          })
        : undefined;
  }
}

const contructed = [];

export default class Database {
  message;
  #data;
  #extra;

  constructor(name) {
    this.name = name;
    if (contructed.includes(name)) {
      throw new RangeError(
        `Cannot create a second database for ${name}, they will have conflicting data`
      );
    }
    contructed.push(name);
  }

  async init() {
    if (this.message) return;
    this.message = databases[this.name] ||= await databaseThread.send(
      `__**COALBOT ${this.name.toUpperCase()} DATABASE**__\n\n*Please don’t delete this message. If you do, all ${this.name.replaceAll(
        "_",
        " "
      )} information may be reset.*`
    );

    const attachment = this.message.attachments.first()?.url;

    this.#data = attachment
      ? await fetch(attachment)
          .then(async (res) => await res.text())
          .then(
            (csv) =>
              papaparse.parse
              (csv.trim(),
              {
                dynamicTyping: true,
                header: true,
                delimiter: ",",
              }).data
          )
      : [];

    // eslint-disable-next-line @typescript-eslint/prefer-destructuring
    this.#extra = this.message.content.split("\n")[5];
  }

  get data() {
    if (!this.#data)
      throw new ReferenceError("Must call `.init()` before reading `.data`");
    return this.#data;
  }
  set data(content) {
    if (!this.message)
      throw new ReferenceError("Must call `.init()` before setting `.data`");
    this.#data = content;
    this.#queueWrite();
  }

  get extra() {
    if (!this.#data)
      throw new ReferenceError("Must call `.init()` before reading `.extra`");
    return this.#extra;
  }
  set extra(content) {
    if (!this.message)
      throw new ReferenceError("Must call `.init()` before setting `.extra`");
    this.#extra = content;
    this.#queueWrite();
  }

  updateById(newData, oldData) {
    const data = [...this.data];
    const index = data.findIndex((suggestion) => suggestion.id === newData.id);
    const suggestion = data[index];
    if (suggestion) data[index] = { ...suggestion, ...newData };
    else if (oldData) data.push({ ...oldData, ...newData });

    this.data = data;
  }

  #queueWrite() {
    if (!this.message) {
      throw new ReferenceError(
        "Must call `.init()` before reading or setting `.data` or `.extra`"
      );
    }

    const timeoutId = timeouts[this.message.id];

    const callback = async () => {
      if (!this.message) {
        throw new ReferenceError(
          "Must call `.init()` before reading or setting `.data` or `.extra`"
        );
      }
      const { message } = this;

      const data =
        this.#data?.length && papaparse.unparse([...this.#data]).trim();

      const files = data
        ? [
            {
              attachment: Buffer.from(data, "utf8"),
              name: `${this.name}.coalbotdb`,
            },
          ]
        : [];
      const messageContent = message.content.split("\n");
      messageContent[3] = "";
      messageContent[4] = this.#extra ? "Extra misc info:" : "";
      messageContent[5] = this.#extra || "";

      const content = messageContent.join("\n").trim();
      const promise = message
        .edit({ content, files })
        .catch(async (error) => {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === RESTJSONErrorCodes.UnknownMessage
          ) {
            databases[this.name] = undefined;
            this.message = undefined;
            await this.init();
            return await callback();
          }

          return await message.edit({ content, files }).catch((retryError) => {
            throw new AggregateError(
              [error, retryError],
              "Failed to write to database!",
              { cause: { data, database: this.name } }
            );
          });
        })
        .then(async (edited) => {
          const attachment = edited.attachments.first()?.url;

          const written =
            attachment &&
            (
              await fetch(attachment).then(async (res) => await res.text())
            ).trim();

          if (attachment && written !== data && !written?.startsWith("<?xml")) {
            throw new Error("Data changed through write!", {
              cause: { written, data, database: this.name },
            });
          }

          return edited;
        });

      timeouts[message.id] = undefined;
      return await promise;
    };

    timeouts[this.message.id] = {
      timeout: setTimeout(callback, 15_000),
      callback,
    };
    if (timeoutId) clearTimeout(timeoutId.timeout);
  }
}

export async function cleanListeners() {
  const count = Object.values(timeouts).length;
  console.log(
    `Cleaning ${count} listener${count === 1 ? "" : "s"}: ${Object.keys(
      timeouts
    ).join(",")}`
  );
  await Promise.all(Object.values(timeouts).map((info) => info?.callback()));
  console.log("Listeners cleaned");
  timeouts = {};
}
export async function prepareExit() {
  await cleanListeners();
  client.user.setStatus("dnd");
  await client.destroy();
}

let called = false,
  exited = false;
for (const [event, code] of Object.entries({
  exit: undefined,
  beforeExit: 0,
  SIGHUP: 12,
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 149,
  message: 0,
})) {
  // eslint-disable-next-line @typescript-eslint/no-loop-func
  process.on(event, (message) => {
    if (called || (event === "message" && message !== "shutdown")) return;
    called = true;

    function doExit() {
      if (exited) return;
      exited = true;

      if (event !== "exit") process.nextTick(() => process.exit(code));
    }

    if (event !== "exit" && Object.values(timeouts).length) {
      void prepareExit().then(() => {
        process.nextTick(doExit);
      });
      setTimeout(doExit, 30_000);
    } else {
      void prepareExit();
      doExit();
    }
  });
}

export async function backupDatabases(channel) {
  if (process.env.NODE_ENV !== "production") return;

  const attachments = Object.values(databases)
    .map((database) => database?.attachments.first())
    .filter(Boolean);

  await channel.send("# Daily CoalBot Database Backup");
  while (attachments.length) {
    await channel.send({ files: attachments.splice(0, 10) });
  }
}
