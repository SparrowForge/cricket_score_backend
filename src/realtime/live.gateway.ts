import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayDisconnect, SubscribeMessage,
  WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { LiveStateService } from '../matches/live-state.service';
import { parseCorsOrigins } from '../common/cors-origins';
import { REDIS_SUB } from '../redis/redis.module';

const ROOM_RE = /^match:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Real-time fan-out. Scoring publishes to live:match:{id}; this gateway
 * relays to Socket.IO rooms. Holds no business logic.
 *
 * Client contract (namespace /live):
 *   emit 'join'  {room:"match:{id}", token?}  → ack {joined}, then receives:
 *       'state'      full snapshot immediately on join
 *       'ball'       {seq, effects, delta, state} per scored ball
 *       'status'     toss/innings/result transitions (full state attached)
 *       'correction' after an undo — replace local state wholesale
 *       'commentary' new commentary entries
 *       'presence'   {viewers, scorers} on join/leave
 *   emit 'leave' {room}
 */
@WebSocketGateway({
  namespace: '/live',
  cors: { origin: parseCorsOrigins(process.env.CORS_ORIGINS) },
})
export class LiveGateway implements OnModuleInit, OnGatewayDisconnect {
  @WebSocketServer() io!: Server;
  private readonly logger = new Logger(LiveGateway.name);

  constructor(
    @Inject(REDIS_SUB) private readonly sub: Redis,
    private readonly liveState: LiveStateService,
    private readonly jwt: JwtService,
  ) {}

  onModuleInit() {
    this.sub.psubscribe('live:match:*', (err) => {
      if (err) this.logger.error(`psubscribe failed: ${err.message}`);
      else this.logger.log('Subscribed to live:match:* channels');
    });
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const matchId = channel.slice('live:match:'.length);
      try {
        const { event, data } = JSON.parse(message);
        this.io.to(`match:${matchId}`).emit(event, data);
      } catch (err) {
        this.logger.warn(`bad pub/sub payload on ${channel}: ${(err as Error).message}`);
      }
    });
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: { room: string; token?: string }) {
    if (!body?.room || !ROOM_RE.test(body.room)) return { error: 'BAD_ROOM' };
    const matchId = body.room.slice('match:'.length);

    // Presence member: scorers (valid JWT) are tagged so the UI can show "scorer online"
    let member = socket.id;
    if (body.token) {
      try {
        const payload = await this.jwt.verifyAsync(body.token);
        if (payload.roles?.some((r: string) => ['scorer', 'tournament_admin', 'super_admin'].includes(r))) {
          member = `scorer:${payload.sub}:${socket.id}`;
        }
      } catch { /* treat as anonymous viewer */ }
    }

    await socket.join(body.room);
    (socket.data.rooms ??= new Map<string, string>()).set(body.room, member);

    await this.liveState.presenceJoin(matchId, member);
    const presence = await this.liveState.presence(matchId);
    this.io.to(body.room).emit('presence', presence);

    // Instant hydration: full snapshot + recent ball stream
    socket.emit('state', await this.liveState.getState(matchId));
    socket.emit('recent_balls', await this.liveState.recentBalls(matchId));
    return { joined: body.room };
  }

  @SubscribeMessage('leave')
  async onLeave(@ConnectedSocket() socket: Socket, @MessageBody() body: { room: string }) {
    if (!body?.room || !ROOM_RE.test(body.room)) return { error: 'BAD_ROOM' };
    await socket.leave(body.room);
    await this.dropPresence(socket, body.room);
    return { left: body.room };
  }

  async handleDisconnect(socket: Socket) {
    const rooms: Map<string, string> | undefined = socket.data.rooms;
    if (!rooms) return;
    for (const room of rooms.keys()) await this.dropPresence(socket, room);
  }

  private async dropPresence(socket: Socket, room: string) {
    const rooms: Map<string, string> | undefined = socket.data.rooms;
    const member = rooms?.get(room);
    if (!member) return;
    rooms!.delete(room);
    const matchId = room.slice('match:'.length);
    await this.liveState.presenceLeave(matchId, member);
    this.io.to(room).emit('presence', await this.liveState.presence(matchId));
  }
}
