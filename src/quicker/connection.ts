import { Alarm, AlarmEvent } from '../types/alarm';
import { TransportParameterType } from '../crypto/transport.parameters';
import { AEAD } from '../crypto/aead';
import { QTLS, HandshakeState, QuicTLSEvents } from '../crypto/qtls';
import { ConnectionID, PacketNumber, Version } from '../packet/header/header.properties';
import { Bignum } from '../types/bignum';
import { RemoteInfo, Socket } from "dgram";
import { Stream, StreamType } from './stream';
import { EndpointType } from '../types/endpoint.type';
import { Constants } from '../utilities/constants';
import { TransportParameters } from '../crypto/transport.parameters';
import { BasePacket, PacketType } from '../packet/base.packet';
import { BaseEncryptedPacket } from '../packet/base.encrypted.packet';
import { AckHandler } from '../utilities/handlers/ack.handler';
import { PacketLogging } from '../utilities/logging/packet.logging';
import { FlowControlledObject } from '../flow-control/flow.controlled';
import { FlowControl } from '../flow-control/flow.control';
import { BaseFrame } from '../frame/base.frame';
import { PacketFactory } from '../utilities/factories/packet.factory';
import { BN } from 'bn.js';
import { QuicStream } from './quic.stream';
import { FrameFactory } from '../utilities/factories/frame.factory';
import { HandshakeHandler } from '../utilities/handlers/handshake.handler';
import { LossDetection, LossDetectionEvents } from '../loss-detection/loss.detection';
import { QuicError } from '../utilities/errors/connection.error';
import { ConnectionErrorCodes } from '../utilities/errors/connection.codes';

export class Connection extends FlowControlledObject {

    private qtls: QTLS;
    private aead: AEAD;
    private socket!: Socket;
    private remoteInfo: RemoteInformation;
    private endpointType: EndpointType;

    private ackHandler: AckHandler;
    private handshakeHandler!: HandshakeHandler;
    private lossDetection: LossDetection;

    private firstConnectionID!: ConnectionID;
    private connectionID!: ConnectionID;
    private initialPacketNumber!: PacketNumber;
    private localPacketNumber!: PacketNumber;
    private remotePacketNumber!: PacketNumber;
    private localTransportParameters!: TransportParameters;
    private remoteTransportParameters!: TransportParameters;
    private version!: Version;

    private remoteMaxStreamUni!: Bignum;
    private remoteMaxStreamBidi!: Bignum;
    private localMaxStreamUni!: Bignum;
    private localMaxStreamBidi!: Bignum;
    private localMaxStreamUniBlocked: boolean;
    private localMaxStreamBidiBlocked: boolean; 

    private earlyData?: Buffer;

    private state!: ConnectionState;
    private streams: Stream[];

    private idleTimeoutAlarm: Alarm;
    private transmissionAlarm: Alarm;
    private bufferedFrames: BaseFrame[];
    private closePacket!: BaseEncryptedPacket;

    public constructor(remoteInfo: RemoteInformation, endpointType: EndpointType, options?: any) {
        super();
        super.init(this);
        this.remoteInfo = remoteInfo;
        this.endpointType = endpointType;
        this.streams = [];
        this.bufferedFrames = [];
        this.idleTimeoutAlarm = new Alarm();
        this.transmissionAlarm = new Alarm();
        if (this.endpointType === EndpointType.Client) {
            this.version = new Version(Buffer.from(Constants.getActiveVersion(), "hex"));
        }
        
        this.qtls = new QTLS(endpointType === EndpointType.Server, options, this);
        this.hookQuicTLSEvents();
        this.aead = new AEAD(this.qtls);
        this.ackHandler = new AckHandler(this);
        this.handshakeHandler = new HandshakeHandler(this);
        this.lossDetection = new LossDetection();
        this.hookLossDetectionEvents();
        this.localMaxStreamUniBlocked = false;
        this.localMaxStreamBidiBlocked = false;
    }

    private hookLossDetectionEvents() {
        this.lossDetection.on(LossDetectionEvents.RETRANSMIT_PACKET, (basePacket: BasePacket) => {
            this.retransmitPacket(basePacket);
        });
    }

    private hookQuicTLSEvents() {
        this.qtls.on(QuicTLSEvents.LOCAL_TRANSPORTPARAM_AVAILABLE, (transportParams: TransportParameters) => {
            this.setLocalTransportParameters(transportParams);
        });
        this.qtls.on(QuicTLSEvents.REMOTE_TRANSPORTPARAM_AVAILABLE, (transportParams: TransportParameters) => {
            this.setRemoteTransportParameters(transportParams);
        });
    }

    public getRemoteInfo(): RemoteInfo {
        return this.remoteInfo;
    }

    public getFirstConnectionID(): ConnectionID {
        return this.firstConnectionID;
    }

    public setFirstConnectionID(connectionID: ConnectionID): void {
        this.firstConnectionID = connectionID;
    }

    public getConnectionID(): ConnectionID {
        return this.connectionID;
    }

    public setConnectionID(connectionID: ConnectionID) {
        this.connectionID = connectionID;
    }

    public getState(): ConnectionState {
        return this.state;
    }

    public setState(connectionState: ConnectionState) {
        this.state = connectionState;
    }

    public getEndpointType(): EndpointType {
        return this.endpointType;
    }

    public getQuicTLS(): QTLS {
        return this.qtls;
    }

    public getAEAD(): AEAD {
        return this.aead;
    }

    public getAckHandler(): AckHandler {
        return this.ackHandler;
    }

    public getLossDetection(): LossDetection {
        return this.lossDetection;
    }

    public getLocalTransportParameter(type: TransportParameterType): any {
        return this.localTransportParameters.getTransportParameter(type);
    }

    public setLocalTransportParameter(type: TransportParameterType, value: any): void {
        this.localTransportParameters.setTransportParameter(type, value);
    }

    public getLocalTransportParameters(): TransportParameters {
        return this.localTransportParameters;
    }

    public getRemoteMaxStreamUni(): Bignum {
        return this.remoteMaxStreamUni;
    }

    public getRemoteMaxStreamBidi(): Bignum {
        return this.remoteMaxStreamBidi;
    }

    setRemoteMaxStreamUni(remoteMaxStreamUni: number): void 
    setRemoteMaxStreamUni(remoteMaxStreamUni: Bignum): void 
    public setRemoteMaxStreamUni(remoteMaxStreamUni: any): void {
        if (remoteMaxStreamUni instanceof Bignum) {
            this.remoteMaxStreamUni = remoteMaxStreamUni;
            return;
        }
        this.remoteMaxStreamUni = new Bignum(remoteMaxStreamUni);
    }

    setRemoteMaxStreamBidi(remoteMaxStreamBidi: number): void 
    setRemoteMaxStreamBidi(remoteMaxStreamBidi: Bignum): void 
    public setRemoteMaxStreamBidi(remoteMaxStreamBidi: any): void {
        if (remoteMaxStreamBidi instanceof Bignum) {
            this.remoteMaxStreamBidi = remoteMaxStreamBidi;
            return;
        }
        this.remoteMaxStreamBidi = new Bignum(remoteMaxStreamBidi);
    }

    public getLocalMaxStreamUni(): Bignum {
        return this.localMaxStreamUni;
    }

    public getLocalMaxStreamBidi(): Bignum {
        return this.localMaxStreamBidi;
    }

    setLocalMaxStreamUni(localMaxStreamUni: number): void 
    setLocalMaxStreamUni(localMaxStreamUni: Bignum): void 
    public setLocalMaxStreamUni(localMaxStreamUni: any): void {
        if (localMaxStreamUni instanceof Bignum) {
            this.localMaxStreamUni = localMaxStreamUni;
            return;
        }
        this.localMaxStreamUni = new Bignum(localMaxStreamUni);
    }

    setLocalMaxStreamBidi(localMaxStreamBidi: number): void 
    setLocalMaxStreamBidi(localMaxStreamBidi: Bignum): void 
    public setLocalMaxStreamBidi(localMaxStreamBidi: any): void {
        if (localMaxStreamBidi instanceof Bignum) {
            this.localMaxStreamBidi = localMaxStreamBidi;
            return;
        }
        this.localMaxStreamBidi = new Bignum(localMaxStreamBidi);
    }
    
    public setLocalMaxStreamUniBlocked(blocked: boolean): void {
        this.localMaxStreamUniBlocked = blocked;
    }
    
    public setLocalMaxStreamBidiBlocked(blocked: boolean): void {
        this.localMaxStreamBidiBlocked = blocked;
    }
    
    public getLocalMaxStreamUniBlocked(): boolean {
        return this.localMaxStreamUniBlocked;
    }
    
    public getLocalMaxStreamBidiBlocked(): boolean {
        return this.localMaxStreamBidiBlocked;
    }

    public setLocalTransportParameters(transportParameters: TransportParameters): void {
        this.localTransportParameters = transportParameters;
        this.setLocalMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_DATA));
        this.setLocalMaxStreamUni(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_UNI));
        this.setLocalMaxStreamBidi(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_BIDI));
        this.streams.forEach((stream: Stream) => {
            stream.setLocalMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        });
    }

    public getRemoteTransportParameter(type: TransportParameterType): any {
        return this.remoteTransportParameters.getTransportParameter(type);
    }

    public setRemoteTransportParameter(type: TransportParameterType, value: any): void {
        this.remoteTransportParameters.setTransportParameter(type, value);
    }

    public getRemoteTransportParameters(): TransportParameters {
        return this.remoteTransportParameters;
    }

    public setRemoteTransportParameters(transportParameters: TransportParameters): void {
        this.remoteTransportParameters = transportParameters;
        this.setRemoteMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_DATA));
        this.setRemoteMaxStreamUni(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_UNI));
        this.setRemoteMaxStreamBidi(transportParameters.getTransportParameter(TransportParameterType.INITIAL_MAX_STREAM_ID_BIDI));
        this.streams.forEach((stream: Stream) => {
            stream.setRemoteMaxData(transportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        });
    }

    public getSocket(): Socket {
        return this.socket;
    }

    public getLocalPacketNumber(): PacketNumber {
        return this.localPacketNumber;
    }

    public setLocalPacketNumber(packetNumber: PacketNumber) {
        this.localPacketNumber = packetNumber;
    }

    public getNextPacketNumber(): PacketNumber {
        if (this.localPacketNumber === undefined) {
            this.localPacketNumber = PacketNumber.randomPacketNumber();
            this.initialPacketNumber = this.localPacketNumber;
            return this.localPacketNumber;
        }
        var bn = this.localPacketNumber.getPacketNumber().add(1);
        this.localPacketNumber.setPacketNumber(bn);
        return this.localPacketNumber;
    }

    public getRemotePacketNumber(): PacketNumber {
        return this.remotePacketNumber;
    }

    public setRemotePacketNumber(packetNumber: PacketNumber) {
        this.remotePacketNumber = packetNumber;
    }

    public getVersion(): Version {
        return this.version;
    }

    public setVersion(version: Version): void {
        this.version = version;
    }

    public setSocket(socket: Socket): void {
        this.socket = socket;
    }

    public getStreams(): Stream[] {
        return this.streams;
    }

    public getStream(streamId: Bignum): Stream {
        var stream = this._getStream(streamId);
        if (stream === undefined) {
            stream = this.initializeStream(streamId);
        }
        return stream;
    }

    private initializeStream(streamId: Bignum): Stream {
        var stream = new Stream(this, streamId);
        this.addStream(stream);
        if (this.localTransportParameters !== undefined) {
            stream.setLocalMaxData(this.localTransportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        }
        if (this.remoteTransportParameters !== undefined) {
            stream.setRemoteMaxData(this.remoteTransportParameters.getTransportParameter(TransportParameterType.MAX_STREAM_DATA));
        }
        if (streamId.compare(new Bignum(0)) !== 0) {
            this.emit(ConnectionEvent.STREAM, new QuicStream(this, stream));
        } else {
            this.handshakeHandler.setHandshakeStream(stream);
        }
        return stream;
    }

    private _getStream(streamId: Bignum): Stream | undefined {
        var res = undefined;
        this.streams.forEach((stream: Stream) => {
            if (stream.getStreamID().equals(streamId)) {
                res = stream;
            }
        });
        return res;
    }

    public addStream(stream: Stream): void {
        if (this._getStream(stream.getStreamID()) === undefined) {
            this.streams.push(stream);
        }
    }

    public deleteStream(streamId: Bignum): void;
    public deleteStream(stream: Stream): void;
    public deleteStream(obj: any): void {
        var stream = undefined;
        if (obj instanceof Bignum) {
            stream = this._getStream(obj);
        } else {
            stream = obj;
        }
        if (stream === undefined) {
            return;
        }
        var index = this.streams.indexOf(stream);
        if (index > -1) {
            this.streams.splice(index, 1);
        }
    }

    public getNextStream(streamType: StreamType): Stream {
        var next = new Bignum(streamType);
        var stream = this._getStream(next);
        while (stream != undefined) {
            next = next.add(4);
            stream = this._getStream(next);
        }
        return this.getStream(next);
    }

    public resetConnectionState() {
        this.remotePacketNumber = new PacketNumber(new Bignum(0).toBuffer());
        this.streams = [];
        this.resetOffsets();
    }

    public queueFrame(baseFrame: BaseFrame) {
        this.queueFrames([baseFrame]);
    }
    
    public queueFrames(baseFrames: BaseFrame[]): void {
        this.bufferedFrames = this.bufferedFrames.concat(baseFrames);
        if (!this.transmissionAlarm.isRunning()) {
            this.startTransmissionAlarm();
        }
    }

    private retransmitPacket(packet: BasePacket) {
        var framePacket = <BaseEncryptedPacket> packet;
        framePacket.getFrames().forEach((frame: BaseFrame) => {
            if (frame.isRetransmittable()) {
                // TODO: Should create new frames AND retransmit data instead of streamframes
                this.queueFrame(frame);
            }
        });
        if (packet.isHandshake()) {
            this.sendPackets();
        }
        
    }

    /**
     * Method to send a packet
     * @param basePacket packet to send
     */
    public sendPacket(basePacket: BasePacket, bufferPacket: boolean = true): void {
        if (basePacket.getPacketType() !== PacketType.Retry && basePacket.getPacketType() !== PacketType.VersionNegotiation && basePacket.getPacketType() !== PacketType.Initial && bufferPacket) {
            var baseEncryptedPacket: BaseEncryptedPacket = <BaseEncryptedPacket>basePacket;
            this.queueFrames(baseEncryptedPacket.getFrames());
        } else {
            this._sendPacket(basePacket);
        }
    }

    public sendPackets(): void {
        this.transmissionAlarm.reset();
        var packets = FlowControl.getPackets(this, this.bufferedFrames);
        packets.forEach((packet: BasePacket) => {
            this._sendPacket(packet);
        });
    }

    private _sendPacket(basePacket: BasePacket): void {
        if (basePacket.getPacketType() !== PacketType.Retry && basePacket.getPacketType() !== PacketType.VersionNegotiation) {
            var baseEncryptedPacket: BaseEncryptedPacket = <BaseEncryptedPacket>basePacket;
            var ackFrame = this.ackHandler.getAckFrame(this);
            if (ackFrame !== undefined) {
                baseEncryptedPacket.getFrames().push(ackFrame);
            }
        }
        var packet = basePacket;
        if (packet !== undefined) {
            packet.getHeader().setPacketNumber(this.getNextPacketNumber());
            PacketLogging.getInstance().logOutgoingPacket(this, packet);
            //this.lossDetection.onPacketSent(packet);
            this.getSocket().send(packet.toBuffer(this), this.getRemoteInfo().port, this.getRemoteInfo().address);
        }
    }

    private addPossibleAckFrame(baseFrames: BaseFrame[]) {
        var ackFrame = this.ackHandler.getAckFrame(this);
        if (ackFrame !== undefined) {
            baseFrames.push(ackFrame);
        }
        return baseFrames;
    }

    private startTransmissionAlarm(): void {
        this.transmissionAlarm.on(AlarmEvent.TIMEOUT, () => {
            console.log("send packets called via transmission alarm");
            this.sendPackets();
        });
        this.transmissionAlarm.start(40);
    }

    public attemptEarlyData(earlyData?: Buffer): boolean {
        if (earlyData !== undefined) {
            this.earlyData = earlyData;
        }
        if (this.earlyData !== undefined && this.getQuicTLS().isEarlyDataAllowed()) {
            var stream = this.getNextStream(StreamType.ClientBidi);
            stream.addData(this.earlyData, true);
            this.sendPackets();
        }
        return false;
    }

    public startConnection(): void {
        if (this.endpointType === EndpointType.Server) {
            throw new QuicError(ConnectionErrorCodes.INTERNAL_ERROR);
        }
        this.handshakeHandler.startHandshake();
        this.sendPackets();
    }


    public getClosePacket(): BaseEncryptedPacket {
        return this.closePacket;
    }

    public setClosePacket(packet: BaseEncryptedPacket): void {
        this.closePacket = packet;
    }

    public closeRequested() {
        var alarm = new Alarm();
        alarm.start(Constants.TEMPORARY_DRAINING_TIME);
        alarm.on(AlarmEvent.TIMEOUT, () => {
            this.emit(ConnectionEvent.CLOSE);
        });
    }

    public resetIdleAlarm(): void {
        this.idleTimeoutAlarm.reset();
    }
    public startIdleAlarm(): void {
        var time = this.localTransportParameters === undefined ? Constants.DEFAULT_IDLE_TIMEOUT : this.getLocalTransportParameter(TransportParameterType.IDLE_TIMEOUT);
        this.idleTimeoutAlarm.on(AlarmEvent.TIMEOUT, () => {
            this.state = ConnectionState.Draining;
            this.closeRequested();
            this.emit(ConnectionEvent.DRAINING);
        })
        this.idleTimeoutAlarm.start(time * 1000);
    }
}

export interface RemoteInformation {
    address: string;
    port: number,
    family: string
}

export enum ConnectionState {
    Handshake,
    Open,
    Closing,
    Draining,
    Closed
}

export enum ConnectionEvent {
    HANDSHAKE_DONE = "con-handshake-done",
    STREAM = "con-stream",
    DRAINING = "con-draining",
    CLOSE = "con-close"
}