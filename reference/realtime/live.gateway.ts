import { OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, SubscribeMessage,
  WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { LiveStateRepository } from '../scoring/live-state.repository';

/**
 * Realtime gateway: fan-out ONLY. No business logic lives here, so this
 * tier scales purely with connection count and deploys never touch scoring.
 * Runs as its own ECS service; the Redis adapter bridges rooms across nodes.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') } })
export class LiveGateway implements OnModuleInit {
  @WebSocketServer() io: Server;

  constructor(
    private readonly redisSub: Redis,   // dedicated subscriber connection
    private readonly redisPub: Redis,
    private readonly liveState: LiveStateRepository,
  ) {}

  onModuleInit() {
    this.io.adapter(createAdapter(this.redisPub, this.redisSub.duplicate()));

    // API publishes scoring deltas; every gw node relays to its local room members.
    this.redisSub.psubscribe('match:*:events', 'tournament:*:ticker');
    this.redisSub.on('pmessage', (_pattern, channel, message) => {
      const payload = JSON.parse(message);
      if (channel.endsWith(':ticker')) {
        const tournamentId = channel.split(':')[1];
        this.io.to(`tournament:${tournamentId}`).volatile.emit('ticker', payload);
      } else {
        const matchId = channel.split(':')[1];
        // event name is embedded by the publisher: ball | wicket | over | status | commentary | correction
        this.io.to(`match:${matchId}`).emit(payload.event, payload.data);
      }
    });
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: { room: string }) {
    if (!/^(match|tournament):[0-9a-f-]{36}$/.test(body.room)) return { error: 'BAD_ROOM' };

    await socket.join(body.room);

    // New joiner immediately gets a consistent snapshot with a seq to sync from.
    if (body.room.startsWith('match:')) {
      const state = await this.liveState.get(body.room.slice(6));
      socket.emit('state', state);
    }
    return { joined: body.room };
  }

  @SubscribeMessage('leave')
  async onLeave(@ConnectedSocket() socket: Socket, @MessageBody() body: { room: string }) {
    await socket.leave(body.room);
  }
}
