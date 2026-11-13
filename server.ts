/**
 * 天涯心安寺 · PartyServer 服务端（多人同场参拜）
 * ============================================================
 * 从已关停的 PartyKit 托管平台迁移而来，跑在用户自己的
 * Cloudflare 账号上：Workers + Durable Objects（PartyServer）。
 *
 * 部署（见同目录 wrangler.jsonc 与 README.md）：
 *   npx wrangler deploy
 * 成功后得到地址，例如 tianya-temple.<子域>.workers.dev，
 * 把那个地址（只要域名，不要 https://，不要末尾斜杠）
 * 填到寺庙网页 index.html 顶部的 PARTYKIT_HOST 常量里，
 * 再重新部署 Cloudflare Pages 即可。
 *
 * 房间：每座殿一个房间，房间名 = 殿 id
 * 天王殿 tianwang / 大雄宝殿 daxiong / 药师殿 yaoshi /
 * 藏经楼 cangjing / 华严殿 huayan /
 * 五百罗汉堂 luohan / 济公殿 jigong / 庭院 courtyard
 * 客户端进哪座殿就连哪个房间，离开即切换。
 *
 * 协议（全部是 JSON 字符串；不可能聊天）：
 * 客户端 → 服务端：
 * { t:"hello", name, robe, x, z, ry, moving, sitting, pose}
 * 进殿报到。name 是系统随机生成的法名（固定字表组合，
 * 不是用户输入），robe 是袈裟颜色。
 * { t:"move", x, z, ry, moving, sitting, pose} 位置/朝向变化
 * { t:"act", pose} 离散动作：bow 合掌 / namaste 跪拜 /
 * fish 敲木鱼 / beads 数念珠 /
 * sit 静坐 / stand 起身 /
 * taichi 太极 / stake 站桩 /
 * scan 身体扫描 / release 放下 /
 * listen 听诵 / idle / walk
 * { t:"hb"} 心跳（每 12 秒一次）
 * { t:"bye"} 离开房间（关连接时也会自动处理）
 * 服务端 → 客户端：
 * { t:"snapshot", you, room, peers:[...]} 进殿后发全殿快照，
 * you 是服务端分配给你的 id，peers 是已在殿里的同修
 * { t:"join", peer} 有新同修进殿
 * { t:"update", id, x, z, ry, moving, sitting, pose}
 * { t:"act", id, pose} 某同修做了个动作
 * { t:"leave", id} 某同修离开
 * { t:"full", room, max} 本殿已满（100 人），请去别的殿
 *
 * 安全：服务端只取白名单字段，绝不原样转发客户端发来的内容；
 * 坐标会被钳制在寺院范围内，姿态只接受白名单里的值。
 */

import { routePartykitRequest, Server } from "partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";

// Durable Object 绑定名 Main（见 wrangler.jsonc）：
// routePartykitRequest 会把 /parties/main/<room> 路由到它，
// 这样现有客户端连默认 main party 不用改。
type Env = {
  Main: DurableObjectNamespace<TemplePartyServer>;
};

// 每间殿上限人数（满了就提示换一间）
const MAX_PEERS_PER_ROOM = 100;
// 心跳超时：超过这么久没收到任何消息，视为掉线，移出房间
const HEARTBEAT_TIMEOUT_MS = 30_000;
// 服务端定期清理的间隔
const PRUNE_INTERVAL_MS = 15_000;

// 允许同步的姿态（白名单）。客户端发来的其他值一律丢弃。
const POSES = new Set([
  "idle",
  "walk",
  "bow",
  "namaste",
  "fish",
  "beads",
  "sit",
  "stand",
  "taichi",
  "stake",
  "scan",
  "release",
  "listen",
]);

function clampNum(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

type Peer = {
  id: string;
  name: string;
  robe: string;
  x: number;
  z: number;
  ry: number;
  moving: boolean;
  sitting: boolean;
  pose: string;
  ready: boolean; // 收到 hello（带法名、袈裟色）后才算正式进殿
  lastSeen: number;
};

// 对外公开的同修状态：只含白名单字段，绝无文字内容
function publicPeer(p: Peer) {
  return {
    id: p.id,
    name: p.name,
    robe: p.robe,
    x: p.x,
    z: p.z,
    ry: p.ry,
    moving: p.moving,
    sitting: p.sitting,
    pose: p.pose,
  };
}

export class TemplePartyServer extends Server<Env> {
  static options = { hibernate: true };

  /** Map<connectionId, peer>：本房间所有连接（含未报到的） */
  peers = new Map<string, Peer>();

  async onStart() {
    // 房间启动时安排第一次定期清理
    await this.schedulePrune().catch(() => {});
  }

  async schedulePrune() {
    try {
      await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    } catch (e) {
      // 存储不可用也不影响消息转发；onMessage 里还有兜底清理
    }
  }

  async onAlarm() {
    this.pruneStale();
    await this.schedulePrune().catch(() => {});
  }

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    // 人数上限：本殿满了就礼貌拒绝，让访客去别的殿
    if (this.peers.size >= MAX_PEERS_PER_ROOM) {
      try {
        conn.send(
          JSON.stringify({
            t: "full",
            room: this.name,
            max: MAX_PEERS_PER_ROOM,
          })
        );
      } catch (e) {}
      try {
        conn.close();
      } catch (e) {}
      return;
    }
    this.peers.set(conn.id, {
      id: conn.id,
      name: "",
      robe: "#8a6d4b",
      x: 0,
      z: 0,
      ry: 0,
      moving: false,
      sitting: false,
      pose: "idle",
      ready: false, // 收到 hello（带法名、袈裟色）后才算正式进殿
      lastSeen: Date.now(),
    });
    this.pruneStale();
  }

  onMessage(sender: Connection, message: WSMessage) {
    const peer = this.peers.get(sender.id);
    if (!peer) return;
    if (typeof message !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      return; // 不是 JSON 就丢弃
    }
    if (!msg || typeof msg.t !== "string") return;
    peer.lastSeen = Date.now();

    if (msg.t === "hello") {
      // 法名只取短字符串（系统随机生成，不是用户输入）；袈裟色同理
      peer.name = typeof msg.name === "string" ? msg.name.slice(0, 12) : "";
      peer.robe =
        typeof msg.robe === "string" ? msg.robe.slice(0, 16) : "#8a6d4b";
      this.applyState(peer, msg);
      peer.ready = true;
      // 1）给新来的人发全殿快照（只含已报到的同修，不含自己）
      const peers = [];
      for (const p of this.peers.values()) {
        if (p.ready && p.id !== peer.id) peers.push(publicPeer(p));
      }
      try {
        sender.send(
          JSON.stringify({
            t: "snapshot",
            you: peer.id,
            room: this.name,
            peers,
          })
        );
      } catch (e) {}
      // 2）告诉殿里其他人：有新同修进殿了
      this.broadcast(
        JSON.stringify({ t: "join", peer: publicPeer(peer) }),
        [sender.id]
      );
      return;
    }

    if (!peer.ready) return; // 没报到就只接受 hello

    if (msg.t === "move") {
      this.applyState(peer, msg);
      this.broadcast(
        JSON.stringify({
          t: "update",
          id: peer.id,
          x: peer.x,
          z: peer.z,
          ry: peer.ry,
          moving: peer.moving,
          sitting: peer.sitting,
          pose: peer.pose,
        }),
        [sender.id]
      );
      this.pruneStale();
      return;
    }

    if (msg.t === "act") {
      if (typeof msg.pose === "string" && POSES.has(msg.pose)) {
        peer.pose = msg.pose;
        if (msg.pose === "sit") peer.sitting = true;
        if (msg.pose === "stand") peer.sitting = false;
        this.broadcast(
          JSON.stringify({ t: "act", id: peer.id, pose: peer.pose }),
          [sender.id]
        );
      }
      return;
    }

    if (msg.t === "hb") return; // 心跳：只刷新 lastSeen，不广播
    if (msg.t === "bye") {
      this.removePeer(sender.id, true);
      return;
    }
    // 其他类型一律忽略
  }

  onClose(conn: Connection) {
    this.removePeer(conn.id, true);
  }

  onError(conn: Connection) {
    this.removePeer(conn.id, true);
  }

  // 只取白名单字段并钳制范围，绝不信任客户端原样发来的值
  applyState(peer: Peer, msg: Record<string, unknown>) {
    peer.x = clampNum(msg.x, -60, 60, peer.x);
    peer.z = clampNum(msg.z, -100, 60, peer.z);
    peer.ry = clampNum(msg.ry, -Math.PI * 2, Math.PI * 2, peer.ry);
    peer.moving = msg.moving === true;
    peer.sitting = msg.sitting === true;
    if (typeof msg.pose === "string" && POSES.has(msg.pose))
      peer.pose = msg.pose;
  }

  // 踢掉超过 30 秒没动静的连接，并通知殿里其他人
  pruneStale() {
    const now = Date.now();
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.removePeer(id, p.ready);
        try {
          this.getConnection(id)?.close();
        } catch (e) {}
      }
    }
  }

  removePeer(id: string, wasReady: boolean) {
    const existed = this.peers.delete(id);
    if (existed && wasReady) {
      this.broadcast(JSON.stringify({ t: "leave", id }));
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
