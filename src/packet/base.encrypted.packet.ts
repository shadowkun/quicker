import {BasePacket, PacketType} from './base.packet';
import {BaseFrame} from '../frame/base.frame';
import {BaseHeader} from './header/base.header';
import {Connection} from '../types/connection';
import {Constants} from '../utilities/constants';
import {PaddingFrame} from '../frame/general/padding';


export abstract class BaseEncryptedPacket extends BasePacket {
    
    
    protected frames: BaseFrame[];

    public constructor(packetType: PacketType, header: BaseHeader, frames: BaseFrame[]) {
        super(packetType,header);
        this.frames = frames;
    }

    public getFrames(): BaseFrame[] {
        return this.frames;
    }

    /**
     * Method to get buffer object from a Packet object
     */
    public toBuffer(connection: Connection) {
        if (this.getHeader() === undefined) {
            throw Error("Header is not defined");
        }
        var headerBuffer = this.getHeader().toBuffer();
        var dataBuffer = this.getFramesBuffer(connection, this.getHeader());

        var buffer = Buffer.alloc(headerBuffer.byteLength + dataBuffer.byteLength);
        var offset = 0;
        headerBuffer.copy(buffer, offset);
        offset += headerBuffer.byteLength;
        dataBuffer.copy(buffer, offset);
        
        return buffer;
    }

    protected getFrameSizes(): number {
        var size  = 0;
        this.frames.forEach((frame: BaseFrame) => {
            size += frame.toBuffer().byteLength;
        });
        return size;
    }

    protected getFramesBuffer(connection: Connection, header: BaseHeader): Buffer {
        var frameSizes = this.getFrameSizes();
        var dataBuffer = Buffer.alloc(frameSizes);
        var offset = 0;
        this.frames.forEach((frame: BaseFrame) => {
            frame.toBuffer().copy(dataBuffer, offset);
            offset += frame.toBuffer().byteLength;
        });
        dataBuffer = this.getEncryptedData(connection, header, dataBuffer);
        return dataBuffer;
    }

    protected abstract getEncryptedData(connection: Connection, header: BaseHeader, dataBuffer: Buffer): Buffer;
}