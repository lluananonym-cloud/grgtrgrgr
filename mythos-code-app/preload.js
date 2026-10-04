const { contextBridge, ipcRenderer } = require("electron");
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, payload) => fn(payload));
contextBridge.exposeInMainWorld("mythos", {
  getCfg: inv("cfg:get"), setCfg: inv("cfg:set"),
  open: inv("open"), pickFolder: inv("pickFolder"), pickFiles: inv("pickFiles"),
  tool: inv("tool"), systemPrompt: inv("prompt:system"), prompts: inv("prompts"), abort: inv("abort"),
  onOutput: on("tool-output"),
  working: inv("working"), notify: inv("notify"), push: inv("push"),
  chats: { list: inv("chats:list"), get: inv("chats:get"), save: inv("chats:save"), remove: inv("chats:delete"), search: inv("chats:search") },
  memory: { get: inv("memory:get"), add: inv("memory:add") },
  git: { info: inv("git:info"), diff: inv("git:diff"), commit: inv("git:commit"), push: inv("git:push"), pr: inv("git:pr") },
  commands: { list: inv("commands:list"), create: inv("commands:create") },
  stats: inv("project:stats"), exportChat: inv("chats:export"),
  safety: { check: inv("safety:check"), status: inv("safety:status"), project: inv("project:config") },
  tests: { detect: inv("tests:detect"), run: inv("tests:run") },
  hooks: { run: inv("hooks:run"), list: inv("hooks:list") },
  mcp: { configure: inv("mcp:configure"), status: inv("mcp:status"), restart: inv("mcp:restart"), onChange: on("mcp-changed") },
  browser: { start: inv("browser:start"), state: inv("browser:state"), reset: inv("browser:pair-reset"), task: inv("browser:task"), stop: inv("browser:stop"), onEvent: on("browser-event") },
  openConfig: inv("config:open"),
  preview: inv("preview:open"),
  files: { list: inv("files:list"), read: inv("files:read"), save: inv("files:save"), reveal: inv("files:reveal"), find: inv("files:find") },
  term: { run: inv("term:run"), kill: inv("term:kill"), cd: inv("term:cd"), onOutput: on("term-output") },
});
