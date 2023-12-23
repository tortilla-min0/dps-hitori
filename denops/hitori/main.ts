import * as fn from "https://deno.land/x/denops_std@v5.2.0/function/mod.ts";
import * as helper from "https://deno.land/x/denops_std@v5.2.0/helper/mod.ts";
import * as vars from "https://deno.land/x/denops_std@v5.2.0/variable/mod.ts";
import * as buffer from "https://deno.land/x/denops_std@v5.2.0/buffer/mod.ts";
import { ensure, is } from "https://deno.land/x/unknownutil@v3.11.0/mod.ts";
import type { Denops } from "https://deno.land/x/denops_std@v5.2.0/mod.ts";

let m_enable = true;
let m_server : Deno.HttpServer;
let m_sockets : Map<WebSocket,BufnrSocketPair> = new Map<WebSocket,BufnrSocketPair>() ;
let m_debug = false;

class BufnrSocketPair{
  bufnr : number;
  ws : WebSocket;

  constructor(bufnr:number,ws:WebSocket)
  {
    this.bufnr = bufnr;
    this.ws = ws;
  }
}

// deno-lint-ignore no-explicit-any
const clog = (...data: any[]): void => {
  if (m_debug) {
    console.log(...data);
  }
};

function isListening(port: number): boolean {
  // running check.
  try {
    const server = Deno.listen({ port });
    server.close();
    return false;
  } catch {
    return true;
  }
}

async function win2wsl(denops: Denops, path: string): Promise<string> {
  if (await fn.has(denops, "wsl") && path[0] !== "/") {
    const cmd = new Deno.Command("wslpath", {
      args: [path],
    });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout).trim();
  }
  return path;
}

async function wsl2win(denops: Denops, path: string): Promise<string> {
  if (!(await fn.has(denops, "wsl")) && Deno.build.os === "windows" && path[0] === "/") {
    const cmd = new Deno.Command("wsl", {
      args: ["wslpath", "-w", path],
    });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout).trim();
  }
  return path;
}

async function serve(denops: Denops) : Promise<boolean>
{
  const hasWin = await fn.has(denops, "win32");
  const hasWsl = await fn.has(denops, "wsl");

  // debug.
  m_debug = await vars.g.get(denops, "hitori_debug", false);
  const quit = await vars.g.get(denops, "hitori_quit", true);
  const port = await vars.g.get(denops, "hitori_port", 7070);
  const wsl = await vars.g.get(denops, "hitori_wsl", false);
  const opener = await vars.g.get(denops, "hitori_opener", "tab drop");
  const ignorePatterns: string[] = await vars.g.get(
    denops,
    "hitori_ignore_patterns",
    ["\\.tmp$", "\\.diff$", "(COMMIT_EDIT|TAG_EDIT|MERGE_|SQUASH_)MSG$"],
  );
  m_enable = await vars.g.get(denops, "hitori_enable", true);

  const isListen = isListening(port);
  if( isListen )
  {
    return false;
  }

  m_server = Deno.serve({ port }, (req) => {
    clog(req);
    const { response, socket } = Deno.upgradeWebSocket(req);
    socket.addEventListener("open", () => clog("[server] open !"));
    socket.addEventListener(
      "error",
      (e) => clog(`[server] error !`, e),
    );
    socket.addEventListener("close", () => 
    {
      clog("[server] close !");
      m_sockets.delete(socket);
    });
    socket.addEventListener(
      "message",
      async (e) => {
        clog(`[server] message ! ${e.data}`);

        let bufPath = e.data;

        // ignore list check.
        if (ignorePatterns.some((p) => new RegExp(p).test(bufPath))) {
          clog(`${bufPath} is ignore list pattern ! so open skip !`);
          socket.send(
            JSON.stringify({
              msg: "This data is ignore list patterns !",
              open: false,
            }),
          );
          return;
        }

        if (!wsl) {
          if (hasWin && bufPath[0] === "/") {
            clog(`${bufPath} is wsl path pattern ! so open skip !`);
            socket.send(
              JSON.stringify({
                msg: "This data is wsl path patterns !",
                open: false,
              }),
            );
            return;
          }
          if (hasWsl && bufPath[0] !== "/") {
            clog(`${bufPath} is windows path pattern ! so open skip !`);
            socket.send(
              JSON.stringify({
                msg: "This data is windows path patterns !",
                open: false,
              }),
            );
            return;
          }
        }
        if (!m_enable) {
          clog(`Disable hitori ...`);
          socket.send(
            JSON.stringify({
              msg: "hitori is disabled !",
              open: false,
            }),
          );
          return;
        }
        if (bufPath) {
          clog(`open ${bufPath}`);
          if (wsl) {
            bufPath = await wsl2win(denops, await win2wsl(denops, bufPath));
          }
          buffer.open(denops, bufPath, { opener }).then( async or=>
          {
            console.log(`open ${bufPath} bufnr:${or.bufnr}`);
            m_sockets.set( socket, new BufnrSocketPair(or.bufnr, socket) );
            await helper.execute(
              denops,
              `
              augroup ${denops.name}_opened_${or.bufnr}
              au!
              autocmd BufUnload * if ${or.bufnr} == expand('<abuf>') | call s:${denops.name}_notify('buf_unload', [expand('<abuf>')]) | au!| endif
              augroup END
            `,
            );
          }).catch(e=>
          {
            socket.send(
              JSON.stringify({
                msg: "Failed open. reason:" + e,
                open: true,
              }),
            );
          });
        } else {
          clog(`data is null !`);
          socket.send(
            JSON.stringify({
              msg: "Not open !",
              open: true,
            }),
          );
        }
      },
    );
    return response;
  });
  return true;
}

export async function main(denops: Denops): Promise<void> {
  let isListen = false;

  // debug.
  m_debug = await vars.g.get(denops, "hitori_debug", false);
  const quit = await vars.g.get(denops, "hitori_quit", true);
  const port = await vars.g.get(denops, "hitori_port", 7070);
  const wsl = await vars.g.get(denops, "hitori_wsl", false);
  const ignorePatterns: string[] = await vars.g.get(
    denops,
    "hitori_ignore_patterns",
    ["\\.tmp$", "\\.diff$", "(COMMIT_EDIT|TAG_EDIT|MERGE_|SQUASH_)MSG$"],
  );
  m_enable = await vars.g.get(denops, "hitori_enable", true);

  clog({ m_debug, port, m_enable, quit, wsl });

  denops.dispatcher = {
    async attach(..._args: unknown[]): Promise<void> {
      try {
        clog(`attach start`);
        if (!m_enable) {
          clog(`g:hitori_enable is false !`);
          return;
        }
        const bufPath = ensure(await fn.expand(denops, "%:p"), is.String);
        clog({ bufPath });

        if (ignorePatterns.some((p) => new RegExp(p).test(bufPath))) {
          clog(`${bufPath} is ignore list pattern ! so open skip !`);
          return;
        }

        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.onopen = async () => {
          clog(`[client] open socket !`);
          clog(`[client] send buf path: ${bufPath}`);
          await denops.cmd(`silent! bwipeout!`);
          ws.send(bufPath);
        };
        ws.onmessage = async (e) => {
          const jsonData = JSON.parse(e.data);
          clog({ jsonData });
          if (!jsonData.open) {
            clog(`Open false, so reopen !`);
            try {
              await buffer.open(denops, bufPath);
            } catch (e) {
              clog(e);
            }
          } else {
            if (quit) {
              await denops.cmd(`silent! qa!`);
            }
            try {
              await buffer.open(denops, bufPath);
            } catch (e) {
              clog(e);
            }
          }
          clog(`[client] close socket !`);
          ws.close();
        };
      } catch (e) {
        clog(e);
      } finally {
        clog(`attach end`);
      }
    },
    // deno-lint-ignore require-await
    async enable(): Promise<void> {
      if( m_enable ){ return; }
      m_enable = await serve( denops );
    },
    // deno-lint-ignore require-await
    async disable(): Promise<void> {
      if( !m_enable ){ return; }
      m_server.shutdown();
      m_enable = false;
    },
    async buf_unload(...args: unknown[]): Promise<void> {
      const bufnr = args[0] as number
      console.log('unloaded bufnr:' + bufnr);
      const pair = Array.from<BufnrSocketPair>(m_sockets.values()).find( bwp => bwp.bufnr == bufnr );
      if( pair === undefined ){ console.log('bufnrs socket is not found : ' + bufnr); return;}
      pair.ws.send(
        JSON.stringify({
          msg: "Success open !",
          open: true,
        }),
      );
    },
  };

  await helper.execute(
    denops,
    `
    function! s:${denops.name}_notify(method, params) abort
      call denops#plugin#wait_async('${denops.name}', function('denops#notify', ['${denops.name}', a:method, a:params]))
    endfunction

    command! EnableHitori call s:${denops.name}_notify('enable', [])
    command! DisableHitori call s:${denops.name}_notify('disable', [])
  `,
  );

  isListen = isListening(port);

  try {
    if (isListen) {
      clog(`Server already running.`);
    } else {
    }
  } catch (e) {
    console.error(e);
  }

  clog("dps-hitori has loaded");
}

