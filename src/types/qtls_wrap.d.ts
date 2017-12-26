import qtls = require("qtls_wrap");

export as namespace qtls_wrap;

export class QuicTLS {
    constructor(isServer: boolean, options:any);

    readHandshakeData(): Buffer;
    writeHandshakeData(buffer: Buffer): number;
    getClientInitial(): Buffer;
    setTransportParameters(buffer: Buffer): void;
    on(event: string, callback: Function): void;
    exportKeyingMaterial(buffer: Buffer, hashsize: number): Buffer;
    getNegotiatedCipher(): string;
}