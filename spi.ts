export interface Spi {
    transfer(data: Buffer): Promise<Buffer>;
}
