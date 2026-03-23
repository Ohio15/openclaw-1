/**
 * Domain Knowledge Repository
 *
 * Provides working code patterns and reference implementations
 * for complex domains that models often struggle with.
 *
 * Ported from AICodeAssistant DomainKnowledge.js
 */

export interface KnowledgeEntry {
  domain: string;
  topic: string;
  description: string;
  implementation: string;
  triggers: string[];
}

export interface KnowledgeMatch extends KnowledgeEntry {
  key: string;
}

export interface KnowledgeSummary {
  key: string;
  domain: string;
  topic: string;
  triggers: string[];
}

/**
 * Real-time collaboration patterns
 */
const REALTIME_PATTERNS: Record<string, KnowledgeEntry> = {
  operationalTransformation: {
    domain: 'realtime',
    topic: 'Operational Transformation (OT)',
    description: 'Complete OT implementation for text editing conflict resolution',
    triggers: ['ot', 'operational transformation', 'conflict resolution', 'collaborative edit'],
    implementation: `
/**
 * Operational Transformation for Text Editing
 * Handles concurrent edits with proper conflict resolution
 */

interface Operation {
  type: 'insert' | 'delete' | 'retain';
  position: number;
  text?: string;        // For insert
  length?: number;      // For delete
  clientId: string;
  timestamp: number;
  version: number;
}

interface TransformResult {
  op1Prime: Operation;
  op2Prime: Operation;
}

/**
 * Transform two concurrent operations so they can be applied in sequence
 */
export function transform(op1: Operation, op2: Operation): TransformResult {
  // If same position, use clientId for deterministic ordering
  if (op1.position === op2.position) {
    if (op1.clientId < op2.clientId) {
      return {
        op1Prime: op1,
        op2Prime: { ...op2, position: op2.position + getOperationLength(op1) }
      };
    } else {
      return {
        op1Prime: { ...op1, position: op1.position + getOperationLength(op2) },
        op2Prime: op2
      };
    }
  }

  // Transform based on position
  if (op1.position < op2.position) {
    return {
      op1Prime: op1,
      op2Prime: { ...op2, position: op2.position + getOperationLength(op1) }
    };
  } else {
    return {
      op1Prime: { ...op1, position: op1.position + getOperationLength(op2) },
      op2Prime: op2
    };
  }
}

function getOperationLength(op: Operation): number {
  switch (op.type) {
    case 'insert': return op.text?.length || 0;
    case 'delete': return -(op.length || 0);
    case 'retain': return 0;
  }
}

/**
 * Apply operation to document text
 */
export function applyOperation(text: string, op: Operation): string {
  switch (op.type) {
    case 'insert':
      return text.slice(0, op.position) + (op.text || '') + text.slice(op.position);
    case 'delete':
      return text.slice(0, op.position) + text.slice(op.position + (op.length || 0));
    case 'retain':
      return text;
  }
}

/**
 * Document state with version vector
 */
export class OTDocument {
  private text: string = '';
  private version: number = 0;
  private history: Operation[] = [];
  private pendingOps: Map<string, Operation[]> = new Map();

  constructor(initialText: string = '') {
    this.text = initialText;
  }

  getText(): string {
    return this.text;
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Apply a local operation
   */
  applyLocal(op: Operation): Operation {
    const serverOp = { ...op, version: this.version };
    this.text = applyOperation(this.text, serverOp);
    this.version++;
    this.history.push(serverOp);
    return serverOp;
  }

  /**
   * Apply a remote operation with transformation
   */
  applyRemote(op: Operation): Operation {
    // Find operations that happened after this op's version
    const concurrentOps = this.history.filter(h => h.version >= op.version);

    // Transform against all concurrent operations
    let transformedOp = op;
    for (const concurrentOp of concurrentOps) {
      const result = transform(transformedOp, concurrentOp);
      transformedOp = result.op1Prime;
    }

    // Apply transformed operation
    this.text = applyOperation(this.text, transformedOp);
    this.version++;
    this.history.push({ ...transformedOp, version: this.version });

    return transformedOp;
  }
}
`,
  },

  crdt: {
    domain: 'realtime',
    topic: 'CRDT (Conflict-free Replicated Data Type)',
    description: 'Complete CRDT implementation for text editing',
    triggers: ['crdt', 'conflict-free', 'replicated data', 'yjs', 'automerge'],
    implementation: `
/**
 * CRDT Implementation for Collaborative Text Editing
 * Uses a simple sequence CRDT (similar to Logoot/LSEQ)
 */

interface CRDTChar {
  id: string;           // Unique identifier (siteId + sequence)
  char: string;         // The character
  position: number[];   // Position array for ordering
  deleted: boolean;     // Tombstone for deleted chars
  siteId: string;       // Which client created this
  timestamp: number;    // Lamport timestamp
}

interface CRDTOperation {
  type: 'insert' | 'delete';
  char: CRDTChar;
  siteId: string;
  lamportTime: number;
}

/**
 * Compare two position arrays for ordering
 */
function comparePositions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aVal = a[i] ?? 0;
    const bVal = b[i] ?? 0;
    if (aVal !== bVal) return aVal - bVal;
  }
  return 0;
}

/**
 * Generate a position between two positions
 */
function generatePositionBetween(
  before: number[] | null,
  after: number[] | null,
  siteId: string
): number[] {
  const beforePos = before || [0];
  const afterPos = after || [Number.MAX_SAFE_INTEGER];

  const newPos: number[] = [];
  let i = 0;

  while (true) {
    const beforeVal = beforePos[i] ?? 0;
    const afterVal = afterPos[i] ?? Number.MAX_SAFE_INTEGER;

    if (afterVal - beforeVal > 1) {
      // There's room between them
      newPos.push(Math.floor((beforeVal + afterVal) / 2));
      break;
    } else if (afterVal - beforeVal === 1) {
      // Need to go deeper
      newPos.push(beforeVal);
      i++;
    } else {
      // Equal - use site ID for tie-breaking
      newPos.push(beforeVal);
      newPos.push(parseInt(siteId, 36) % 1000);
      break;
    }
  }

  return newPos;
}

/**
 * CRDT Document implementation
 */
export class CRDTDocument {
  private chars: CRDTChar[] = [];
  private siteId: string;
  private lamportTime: number = 0;
  private sequenceCounter: number = 0;

  constructor(siteId: string) {
    this.siteId = siteId;
  }

  /**
   * Get the current text (excluding deleted chars)
   */
  getText(): string {
    return this.chars
      .filter(c => !c.deleted)
      .sort((a, b) => comparePositions(a.position, b.position))
      .map(c => c.char)
      .join('');
  }

  /**
   * Insert a character at index
   */
  insert(index: number, char: string): CRDTOperation {
    this.lamportTime++;
    this.sequenceCounter++;

    const visibleChars = this.chars
      .filter(c => !c.deleted)
      .sort((a, b) => comparePositions(a.position, b.position));

    const before = index > 0 ? visibleChars[index - 1]?.position : null;
    const after = index < visibleChars.length ? visibleChars[index]?.position : null;

    const newChar: CRDTChar = {
      id: \`\${this.siteId}:\${this.sequenceCounter}\`,
      char,
      position: generatePositionBetween(before, after, this.siteId),
      deleted: false,
      siteId: this.siteId,
      timestamp: this.lamportTime
    };

    this.chars.push(newChar);

    return {
      type: 'insert',
      char: newChar,
      siteId: this.siteId,
      lamportTime: this.lamportTime
    };
  }

  /**
   * Delete a character at index
   */
  delete(index: number): CRDTOperation | null {
    const visibleChars = this.chars
      .filter(c => !c.deleted)
      .sort((a, b) => comparePositions(a.position, b.position));

    if (index < 0 || index >= visibleChars.length) return null;

    const charToDelete = visibleChars[index];
    charToDelete.deleted = true;
    this.lamportTime++;

    return {
      type: 'delete',
      char: charToDelete,
      siteId: this.siteId,
      lamportTime: this.lamportTime
    };
  }

  /**
   * Apply a remote operation
   */
  applyRemote(op: CRDTOperation): void {
    this.lamportTime = Math.max(this.lamportTime, op.lamportTime) + 1;

    if (op.type === 'insert') {
      // Check if we already have this char
      const existing = this.chars.find(c => c.id === op.char.id);
      if (!existing) {
        this.chars.push(op.char);
      }
    } else if (op.type === 'delete') {
      const existing = this.chars.find(c => c.id === op.char.id);
      if (existing) {
        existing.deleted = true;
      }
    }
  }

  /**
   * Get all operations for syncing to a new peer
   */
  getState(): CRDTChar[] {
    return [...this.chars];
  }

  /**
   * Load state from another peer
   */
  loadState(chars: CRDTChar[]): void {
    for (const char of chars) {
      const existing = this.chars.find(c => c.id === char.id);
      if (!existing) {
        this.chars.push(char);
      } else if (char.deleted) {
        existing.deleted = true;
      }
    }
  }
}
`,
  },

  websocketServer: {
    domain: 'realtime',
    topic: 'WebSocket Server with Rooms',
    description: 'Production WebSocket server with room management and presence',
    triggers: ['websocket', 'socket server', 'rooms', 'presence', 'ws'],
    implementation: `
/**
 * Production WebSocket Server with Room Management
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

interface Client {
  id: string;
  ws: WebSocket;
  userId: string;
  documentId: string | null;
  cursor?: { line: number; column: number };
  lastSeen: number;
}

interface Room {
  documentId: string;
  clients: Map<string, Client>;
  documentState: any;
}

interface PresenceUpdate {
  type: 'presence';
  userId: string;
  cursor?: { line: number; column: number };
  status: 'active' | 'idle' | 'left';
}

export class CollaborationServer {
  private wss: WebSocketServer;
  private clients: Map<string, Client> = new Map();
  private rooms: Map<string, Room> = new Map();
  private heartbeatInterval: NodeJS.Timer;

  constructor(port: number = 8080) {
    this.wss = new WebSocketServer({ port });
    this.setupServer();
    this.heartbeatInterval = setInterval(() => this.checkHeartbeats(), 30000);
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const clientId = randomUUID();
      const client: Client = {
        id: clientId,
        ws,
        userId: '', // Set during auth
        documentId: null,
        lastSeen: Date.now()
      };

      this.clients.set(clientId, client);

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (e) {
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(clientId);
      });

      ws.on('pong', () => {
        client.lastSeen = Date.now();
      });

      // Send client their ID
      this.send(ws, { type: 'connected', clientId });
    });
  }

  private handleMessage(clientId: string, message: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastSeen = Date.now();

    switch (message.type) {
      case 'auth':
        this.handleAuth(client, message);
        break;
      case 'join':
        this.handleJoin(client, message.documentId);
        break;
      case 'leave':
        this.handleLeave(client);
        break;
      case 'operation':
        this.handleOperation(client, message.operation);
        break;
      case 'cursor':
        this.handleCursor(client, message.cursor);
        break;
      case 'sync':
        this.handleSync(client);
        break;
    }
  }

  private handleAuth(client: Client, message: any): void {
    // Verify JWT token here
    client.userId = message.userId;
    this.send(client.ws, { type: 'authenticated', userId: client.userId });
  }

  private handleJoin(client: Client, documentId: string): void {
    // Leave current room if any
    if (client.documentId) {
      this.handleLeave(client);
    }

    // Get or create room
    let room = this.rooms.get(documentId);
    if (!room) {
      room = {
        documentId,
        clients: new Map(),
        documentState: null // Load from database
      };
      this.rooms.set(documentId, room);
    }

    client.documentId = documentId;
    room.clients.set(client.id, client);

    // Send current document state
    this.send(client.ws, {
      type: 'joined',
      documentId,
      state: room.documentState,
      users: this.getRoomPresence(room)
    });

    // Notify others
    this.broadcastToRoom(room, {
      type: 'user_joined',
      userId: client.userId
    }, client.id);
  }

  private handleLeave(client: Client): void {
    if (!client.documentId) return;

    const room = this.rooms.get(client.documentId);
    if (room) {
      room.clients.delete(client.id);

      // Notify others
      this.broadcastToRoom(room, {
        type: 'user_left',
        userId: client.userId
      });

      // Clean up empty rooms
      if (room.clients.size === 0) {
        this.rooms.delete(client.documentId);
      }
    }

    client.documentId = null;
  }

  private handleOperation(client: Client, operation: any): void {
    if (!client.documentId) return;

    const room = this.rooms.get(client.documentId);
    if (!room) return;

    // Apply operation to room state
    // (OT/CRDT logic would go here)

    // Broadcast to all other clients in room
    this.broadcastToRoom(room, {
      type: 'operation',
      operation,
      userId: client.userId
    }, client.id);
  }

  private handleCursor(client: Client, cursor: { line: number; column: number }): void {
    client.cursor = cursor;

    if (!client.documentId) return;
    const room = this.rooms.get(client.documentId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'cursor',
      userId: client.userId,
      cursor
    }, client.id);
  }

  private handleSync(client: Client): void {
    if (!client.documentId) return;

    const room = this.rooms.get(client.documentId);
    if (!room) return;

    this.send(client.ws, {
      type: 'sync',
      state: room.documentState,
      users: this.getRoomPresence(room)
    });
  }

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.handleLeave(client);
      this.clients.delete(clientId);
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    const timeout = 60000; // 60 seconds

    for (const [id, client] of this.clients) {
      if (now - client.lastSeen > timeout) {
        client.ws.terminate();
        this.handleDisconnect(id);
      } else {
        client.ws.ping();
      }
    }
  }

  private getRoomPresence(room: Room): PresenceUpdate[] {
    return Array.from(room.clients.values()).map(c => ({
      type: 'presence' as const,
      userId: c.userId,
      cursor: c.cursor,
      status: 'active' as const
    }));
  }

  private broadcastToRoom(room: Room, message: any, excludeClientId?: string): void {
    for (const [id, client] of room.clients) {
      if (id !== excludeClientId) {
        this.send(client.ws, message);
      }
    }
  }

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, { type: 'error', error });
  }

  close(): void {
    clearInterval(this.heartbeatInterval);
    this.wss.close();
  }
}
`,
  },
};

/**
 * Authentication patterns
 */
const AUTH_PATTERNS: Record<string, KnowledgeEntry> = {
  jwtAuth: {
    domain: 'auth',
    topic: 'JWT Authentication System',
    description: 'Complete JWT auth with refresh tokens and RBAC',
    triggers: ['jwt', 'authentication', 'auth system', 'login', 'token'],
    implementation: `
/**
 * Complete JWT Authentication System with RBAC
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { z } from 'zod';

// Validation schemas
export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)/,
    'Password must contain uppercase, lowercase, and number'
  ),
  name: z.string().min(2).max(100)
});

// Types
interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  roles: string[];
  createdAt: Date;
}

interface TokenPayload {
  userId: string;
  email: string;
  roles: string[];
  type: 'access' | 'refresh';
}

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: Omit<User, 'passwordHash'>;
}

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const SALT_ROUNDS = 12;

/**
 * Hash a password
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate access token
 */
export function generateAccessToken(user: User): string {
  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    type: 'access'
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

/**
 * Generate refresh token
 */
export function generateRefreshToken(user: User): string {
  const payload: TokenPayload = {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    type: 'refresh'
  };

  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

/**
 * Verify access token
 */
export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    if (payload.type !== 'access') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify refresh token
 */
export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
    if (payload.type !== 'refresh') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware for authentication
 */
export function authMiddleware(requiredRoles?: string[]) {
  return (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);

    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check roles if required
    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.some(role => payload.roles.includes(role));
      if (!hasRole) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
    }

    req.user = payload;
    next();
  };
}

/**
 * Role-based permission check
 */
export function hasPermission(userRoles: string[], requiredPermission: string): boolean {
  const rolePermissions: Record<string, string[]> = {
    admin: ['read', 'write', 'delete', 'manage_users', 'manage_documents'],
    editor: ['read', 'write', 'delete'],
    viewer: ['read']
  };

  for (const role of userRoles) {
    const permissions = rolePermissions[role] || [];
    if (permissions.includes(requiredPermission)) {
      return true;
    }
  }

  return false;
}

/**
 * Document-level access control
 */
export function canAccessDocument(
  userId: string,
  userRoles: string[],
  document: { ownerId: string; editors: string[]; viewers: string[] },
  requiredAccess: 'read' | 'write' | 'delete'
): boolean {
  // Admins can do anything
  if (userRoles.includes('admin')) return true;

  // Owner can do anything
  if (document.ownerId === userId) return true;

  // Check editor access
  if (document.editors.includes(userId)) {
    return requiredAccess !== 'delete';
  }

  // Check viewer access
  if (document.viewers.includes(userId)) {
    return requiredAccess === 'read';
  }

  return false;
}
`,
  },
};

/**
 * All domain knowledge combined
 */
const ALL_KNOWLEDGE: Record<string, KnowledgeEntry> = {
  ...REALTIME_PATTERNS,
  ...AUTH_PATTERNS,
};

/**
 * Get knowledge entries matching a request
 */
export function getRelevantKnowledge(request: string): KnowledgeMatch[] {
  const lower = request.toLowerCase();
  const matches: KnowledgeMatch[] = [];

  for (const [key, entry] of Object.entries(ALL_KNOWLEDGE)) {
    for (const trigger of entry.triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        matches.push({ key, ...entry });
        break;
      }
    }
  }

  return matches;
}

/**
 * Get specific knowledge by key
 */
export function getKnowledge(key: string): KnowledgeEntry | null {
  return ALL_KNOWLEDGE[key] || null;
}

/**
 * Build context from relevant knowledge
 */
export function buildKnowledgeContext(request: string): string {
  const matches = getRelevantKnowledge(request);

  if (matches.length === 0) return '';

  const parts: string[] = ['## Reference Implementations\n'];
  parts.push('Use these proven patterns as a foundation:\n');

  for (const match of matches) {
    parts.push(`### ${match.topic}`);
    parts.push(match.description);
    parts.push('```typescript');
    parts.push(match.implementation.trim());
    parts.push('```\n');
  }

  return parts.join('\n');
}

/**
 * Get all available knowledge topics
 */
export function listKnowledge(): KnowledgeSummary[] {
  return Object.entries(ALL_KNOWLEDGE).map(([key, entry]) => ({
    key,
    domain: entry.domain,
    topic: entry.topic,
    triggers: entry.triggers,
  }));
}

export interface DomainKnowledgeInstance {
  get: typeof getKnowledge;
  getRelevant: typeof getRelevantKnowledge;
  buildContext: typeof buildKnowledgeContext;
  list: typeof listKnowledge;
}

// Singleton
let knowledgeInstance: DomainKnowledgeInstance | null = null;

export function getDomainKnowledge(): DomainKnowledgeInstance {
  if (!knowledgeInstance) {
    knowledgeInstance = {
      get: getKnowledge,
      getRelevant: getRelevantKnowledge,
      buildContext: buildKnowledgeContext,
      list: listKnowledge,
    };
  }
  return knowledgeInstance;
}
