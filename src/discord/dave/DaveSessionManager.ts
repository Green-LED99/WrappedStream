import type { Logger } from '../../utils/logger.js';
import type { DaveKeyRatchet, DaveModule, DaveSessionInstance, DaveTransientKeys } from './types.js';

const NEW_GROUP_EPOCH = 1;
const DISABLED_PROTOCOL_VERSION = 0;
const INIT_TRANSITION_ID = 0;

type SendJsonOpcode = (opcode: number, payload: Record<string, unknown>) => void;
type SendBinaryOpcode = (opcode: number, payload: Uint8Array) => void;
type OnSelfKeyRatchetUpdated = (keyRatchet: DaveKeyRatchet | null) => void;

export class DaveSessionManager {
  private readonly session: DaveSessionInstance;
  private readonly recognizedUserIds = new Set<string>();
  private readonly pendingTransitions = new Map<number, number>();
  private latestPreparedProtocolVersion = DISABLED_PROTOCOL_VERSION;

  public constructor(
    private readonly dave: DaveModule,
    private readonly selfUserId: string,
    private readonly groupId: string,
    private readonly transientKeys: DaveTransientKeys,
    private readonly logger: Logger,
    private readonly sendJsonOpcode: SendJsonOpcode,
    private readonly sendBinaryOpcode: SendBinaryOpcode,
    private readonly onSelfKeyRatchetUpdated: OnSelfKeyRatchetUpdated
  ) {
    this.session = new dave.Session('', '', (source, reason) => {
      this.logger.error('MLS failure', { source, reason });
    });
  }

  public createUser(userId: string): void {
    this.recognizedUserIds.add(userId);
    this.setupKeyRatchetForUser(userId, this.latestPreparedProtocolVersion);
  }

  public destroyUser(userId: string): void {
    this.recognizedUserIds.delete(userId);
  }

  public onSelectProtocolAck(protocolVersion: number): void {
    this.handleProtocolInitialization(protocolVersion);
  }

  public onPrepareTransition(transitionId: number, protocolVersion: number): void {
    this.prepareRatchets(transitionId, protocolVersion);
    this.maybeSendReadyForTransition(transitionId);
  }

  public onExecuteTransition(transitionId: number): void {
    if (!this.pendingTransitions.has(transitionId)) return;

    const protocolVersion = this.pendingTransitions.get(transitionId)!;
    this.pendingTransitions.delete(transitionId);

    if (protocolVersion === DISABLED_PROTOCOL_VERSION) {
      this.session.Reset();
      this.onSelfKeyRatchetUpdated(null);
      return;
    }

    this.setupKeyRatchetForUser(this.selfUserId, protocolVersion);
  }

  public onPrepareEpoch(epoch: number, protocolVersion: number): void {
    this.handlePrepareEpoch(epoch, protocolVersion);

    if (epoch === NEW_GROUP_EPOCH) {
      this.sendMlsKeyPackage();
    }
  }

  public onExternalSenderPackage(externalSenderPackage: Uint8Array): void {
    this.session.SetExternalSender(Array.from(externalSenderPackage));
  }

  public onMlsProposals(proposals: Uint8Array): void {
    const commitWelcome = this.session.ProcessProposals(
      Array.from(proposals),
      this.getRecognizedUserIds()
    );

    if (commitWelcome) {
      this.sendBinaryOpcode(28, Uint8Array.from(commitWelcome));
    }
  }

  public onMlsAnnounceCommitTransition(transitionId: number, commit: Uint8Array): void {
    const processedCommit = this.session.ProcessCommit(Array.from(commit));

    if (processedCommit.ignored) return;

    if (processedCommit.failed || processedCommit.rosterUpdate === null) {
      this.flagInvalidCommitWelcome(transitionId);
      this.handleProtocolInitialization(this.session.GetProtocolVersion());
      return;
    }

    this.prepareRatchets(transitionId, this.session.GetProtocolVersion());
    this.maybeSendReadyForTransition(transitionId);
  }

  public onMlsWelcome(transitionId: number, welcome: Uint8Array): void {
    const roster = this.session.ProcessWelcome(Array.from(welcome), this.getRecognizedUserIds());

    if (roster !== null) {
      this.prepareRatchets(transitionId, this.session.GetProtocolVersion());
      this.maybeSendReadyForTransition(transitionId);
      return;
    }

    this.flagInvalidCommitWelcome(transitionId);
    this.sendMlsKeyPackage();
  }

  public getProtocolVersion(): number {
    return this.session.GetProtocolVersion();
  }

  private sendMlsKeyPackage(): void {
    const keyPackage = Uint8Array.from(this.session.GetMarshalledKeyPackage());
    this.sendBinaryOpcode(26, keyPackage);
  }

  private maybeSendReadyForTransition(transitionId: number): void {
    if (transitionId === INIT_TRANSITION_ID) return;
    this.sendJsonOpcode(23, { transition_id: transitionId });
  }

  private flagInvalidCommitWelcome(transitionId: number): void {
    this.sendJsonOpcode(31, { transition_id: transitionId });
  }

  private setupKeyRatchetForUser(userId: string, protocolVersion: number): void {
    const keyRatchet =
      protocolVersion === DISABLED_PROTOCOL_VERSION ? null : this.session.GetKeyRatchet(userId);

    if (userId === this.selfUserId) {
      this.onSelfKeyRatchetUpdated(keyRatchet);
    }
  }

  private handleProtocolInitialization(protocolVersion: number): void {
    if (protocolVersion > DISABLED_PROTOCOL_VERSION) {
      this.handlePrepareEpoch(NEW_GROUP_EPOCH, protocolVersion);
      this.sendMlsKeyPackage();
      return;
    }

    this.prepareRatchets(INIT_TRANSITION_ID, protocolVersion);
    this.onExecuteTransition(INIT_TRANSITION_ID);
  }

  private handlePrepareEpoch(epoch: number, protocolVersion: number): void {
    if (epoch !== NEW_GROUP_EPOCH) {
      this.session.SetProtocolVersion(protocolVersion);
      return;
    }

    const transientKey = this.transientKeys.GetTransientPrivateKey(protocolVersion);
    this.session.Init(protocolVersion, BigInt(this.groupId), this.selfUserId, transientKey);
  }

  private prepareRatchets(transitionId: number, protocolVersion: number): void {
    for (const userId of this.getRecognizedUserIds()) {
      if (userId === this.selfUserId) continue;
      this.setupKeyRatchetForUser(userId, protocolVersion);
    }

    if (transitionId === INIT_TRANSITION_ID) {
      this.setupKeyRatchetForUser(this.selfUserId, protocolVersion);
    } else {
      this.pendingTransitions.set(transitionId, protocolVersion);
    }

    this.latestPreparedProtocolVersion = protocolVersion;
  }

  private getRecognizedUserIds(): string[] {
    return [...this.recognizedUserIds, this.selfUserId];
  }
}
