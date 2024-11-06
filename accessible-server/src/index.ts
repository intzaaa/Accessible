import { ClientRequest, request } from "http";
import SimplePeer from "simple-peer";
import { io } from "socket.io-client";
import nodeDatachannelPolyfill from "node-datachannel/polyfill";
import { UUID, verify } from "crypto";
import { BSON } from "bson";
import { clone } from "ramda";

const env = clone(process.env);

const requiredConfig = {
  target: env["AC_TARGET"]!,
  signal: env["AC_SIGNAL"]!,
};

const optionalConfig = {};

export const config = {
  ...requiredConfig,
  ...optionalConfig,
};

const socket = io(config.signal, {
  autoConnect: false,
});

process.on("exit", (code) => {
  socket.emit(
    "down",
    {
      code,
    },
    socket.close
  );
});

await new Promise<void>((resolve) => {
  socket.on("disconnect", () => {
    throw new Error("Lost connection to signal server");
  });

  socket.connect();

  socket.on("connect", () => {
    socket.emit(
      "up",
      {
        key: env["AC_KEY"],
      },
      resolve
    );
  });
});

const peers: Map<UUID, SimplePeer.Instance> = new Map();

const connections: Map<UUID, ClientRequest> = new Map();

socket.on("signal", (signal: { id: UUID; data: any }) => {
  if (peers[signal.id]) {
    peers[signal.id].signal(signal.data);

    return;
  }

  const peer = new SimplePeer({
    wrtc: nodeDatachannelPolyfill as any,
  });

  peer.signal(signal.data);

  peer.on("data", (data) => {
    const { id, state, chunk } = BSON.deserialize(data) as {
      id: UUID;
      state: number;
      chunk: any;
    };

    const start = state === 0;
    const end = state === -1;
    const error = state === -2;

    if (error) {
      connections.get(id)!.destroy();
      connections.delete(id);

      return;
    }

    if (end) {
      connections.get(id)!.end();
      connections.delete(id);

      return;
    }

    if (start) {
      let idx = 0;
      const req = request(config.target!, (res) => {
        res.on("data", (chunk) => {
          peer.send(
            BSON.serialize({
              id,
              state: idx,
              chunk,
            })
          );

          idx++;
        });

        res.on("end", () => {
          peer.send(
            BSON.serialize({
              id,
              state: -1,
              chunk: null,
            })
          );
        });

        res.on("error", (error) => {
          peer.send(
            BSON.serialize({
              id,
              state: -2,
              chunk: error,
            })
          );
        });
      });

      req.write(chunk);
      connections.set(id, req);

      return;
    }

    connections.get(id)!.write(chunk);
  });

  peers[signal.id] = peer;
});
