// tslint:disable:max-line-length
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';

import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/interval';
import 'rxjs/add/observable/throw';
import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/first';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/startWith';
import 'rxjs/add/operator/take';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/timeout';
import 'rxjs/add/operator/toPromise';

import * as c from './constants';
import { RadioConfig } from './RadioConfig';
import { RadioError } from './RadioError';
import { RfBand } from './RfBand';
import { RfMode } from './RfMode';
import { Spi } from './Spi';

const RF69_FSTEP = 61.03515625; // == FXOSC / 2^19 = 32MHz / 2^19 (p13 in datasheet)

export class Radio {
    private _nodeId: number;
    private _networkId: number;
    private _powerLevel = 31;
    private _band: RfBand;
    private _isRfm69Hw: boolean;
    private _mode: RfMode;
    private _interrupt: Observable<void>;
    private _data = new Subject<{ data: Buffer, rssi: number, from: number }>();
    private _sendQueue = new Subject<{ data: Buffer, to: number, resolve: () => void, reject: (err) => void }>();
    private _stop: Subject<void>;

    get data() {
        return this._data.asObservable();
    }

    constructor(
        private _spi: Spi,
        interrupt: Observable<any>,
        { nodeId = 1, networkId = 1, band = RfBand.Rf433MHZ, isRfm69Hw = true }: RadioConfig = {},
    ) {
        this._nodeId = nodeId;
        this._networkId = networkId;
        this._band = band;
        this._isRfm69Hw = isRfm69Hw;
        this._interrupt = interrupt.share();
    }

    stop() {
        if (this._stop === void 0) {
            throw new RadioError('not inited; call init first!');
        }
        this._stop.next();
        this._stop.complete();
        delete this._stop;
    }

    async init() {
        if (this._stop !== void 0) {
            throw new RadioError('already inited; call stop first!');
        }
        this._stop = new Subject();
        this._sendQueue
            .concatMap(async s => {
                try {
                    await this.sendInternal(s.to, s.data);
                    s.resolve();
                } catch (err) {
                    s.reject(err);
                }
            })
            .takeUntil(this._stop)
            .subscribe();

        const config = [
            /* 0x01 */[c.REG_OPMODE, c.RF_OPMODE_SEQUENCER_ON | c.RF_OPMODE_LISTEN_OFF | c.RF_OPMODE_STANDBY],
            /* 0x02 */[c.REG_DATAMODUL, c.RF_DATAMODUL_DATAMODE_PACKET | c.RF_DATAMODUL_MODULATIONTYPE_FSK | c.RF_DATAMODUL_MODULATIONSHAPING_00], // no shaping
            /* 0x03 */[c.REG_BITRATEMSB, c.RF_BITRATEMSB_55555], // default: 4.8 KBPS
            /* 0x04 */[c.REG_BITRATELSB, c.RF_BITRATELSB_55555],
            /* 0x05 */[c.REG_FDEVMSB, c.RF_FDEVMSB_50000], // default: 5KHz, (FDEV + BitRate / 2 <= 500KHz)
            /* 0x06 */[c.REG_FDEVLSB, c.RF_FDEVLSB_50000],

            /* 0x07 */[c.REG_FRFMSB, this.frMsb],
            /* 0x08 */[c.REG_FRFMID, this.frMid],
            /* 0x09 */[c.REG_FRFLSB, this.frLsb],

            // looks like PA1 and PA2 are not implemented on RFM69W, hence the max output power is 13dBm
            // +17dBm and +20dBm are possible on RFM69HW
            // +13dBm formula: Pout = -18 + OutputPower (with PA0 or PA1**)
            // +17dBm formula: Pout = -14 + OutputPower (with PA1 and PA2)**
            // +20dBm formula: Pout = -11 + OutputPower (with PA1 and PA2)** and high power PA settings (section 3.3.7 in datasheet)
            // 0x11 */ { REG_PALEVEL, RF_PALEVEL_PA0_ON | RF_PALEVEL_PA1_OFF | RF_PALEVEL_PA2_OFF | RF_PALEVEL_OUTPUTPOWER_11111},
            // 0x13 */ { REG_OCP, RF_OCP_ON | RF_OCP_TRIM_95 }, // over current protection (default is 95mA)

            // RXBW defaults are { REG_RXBW, RF_RXBW_DCCFREQ_010 | RF_RXBW_MANT_24 | RF_RXBW_EXP_5} (RxBw: 10.4KHz)
            /* 0x19 */[c.REG_RXBW, c.RF_RXBW_DCCFREQ_010 | c.RF_RXBW_MANT_16 | c.RF_RXBW_EXP_2], // (BitRate < 2 * RxBw)
            // for BR-19200: /* 0x19 */ { REG_RXBW, RF_RXBW_DCCFREQ_010 | RF_RXBW_MANT_24 | RF_RXBW_EXP_3 },
            /* 0x25 */[c.REG_DIOMAPPING1, c.RF_DIOMAPPING1_DIO0_01], // DIO0 is the only IRQ we're using
            /* 0x26 */[c.REG_DIOMAPPING2, c.RF_DIOMAPPING2_CLKOUT_OFF], // DIO5 ClkOut disable for power saving
            /* 0x28 */[c.REG_IRQFLAGS2, c.RF_IRQFLAGS2_FIFOOVERRUN], // writing to this bit ensures that the FIFO & status flags are reset
            /* 0x29 */[c.REG_RSSITHRESH, 220], // must be set to dBm = (-Sensitivity / 2), default is 0xE4 = 228 so -114dBm
            // * 0x2D */ { REG_PREAMBLELSB, RF_PREAMBLESIZE_LSB_VALUE } // default 3 preamble bytes 0xAAAAAA
            /* 0x2E */[c.REG_SYNCCONFIG, c.RF_SYNC_ON | c.RF_SYNC_FIFOFILL_AUTO | c.RF_SYNC_SIZE_2 | c.RF_SYNC_TOL_0],
            /* 0x2F */[c.REG_SYNCVALUE1, 0x2D],      // attempt to make this compatible with sync1 byte of RFM12B lib
            /* 0x30 */[c.REG_SYNCVALUE2, this._networkId], // NETWORK ID
            /* 0x37 */[c.REG_PACKETCONFIG1, c.RF_PACKET1_FORMAT_VARIABLE | c.RF_PACKET1_DCFREE_OFF | c.RF_PACKET1_CRC_ON | c.RF_PACKET1_CRCAUTOCLEAR_ON | c.RF_PACKET1_ADRSFILTERING_NODE],
            /* 0x38 */[c.REG_PAYLOADLENGTH, 66], // in variable length mode: the max frame size, not used in TX
            /* 0x39 */[c.REG_NODEADRS, this._nodeId],
            /* 0x3C */[c.REG_FIFOTHRESH, c.RF_FIFOTHRESH_TXSTART_FIFONOTEMPTY | c.RF_FIFOTHRESH_VALUE], // TX on FIFO not empty
            /* 0x3D */[c.REG_PACKETCONFIG2, c.RF_PACKET2_RXRESTARTDELAY_2BITS | c.RF_PACKET2_AUTORXRESTART_ON | c.RF_PACKET2_AES_OFF], // RXRESTARTDELAY must match transmitter PA ramp-down time (bitrate dependent)
            // for BR-19200: /* 0x3D */ { REG_PACKETCONFIG2, RF_PACKET2_RXRESTARTDELAY_NONE | RF_PACKET2_AUTORXRESTART_ON | RF_PACKET2_AES_OFF }, // RXRESTARTDELAY must match transmitter PA ramp-down time (bitrate dependent)
            /* 0x6F */[c.REG_TESTDAGC, c.RF_DAGC_IMPROVED_LOWBETA0], // run DAGC continuously in RX mode for Fading Margin Improvement, recommended default for AfcLowBetaOn=0
        ];

        await this.setSyncAndWait(0xAA);
        await this.setSyncAndWait(0x55);

        for (const [register, value] of config) {
            await this.writeReg(register, value);
        }

        // Encryption is persistent between resets and can trip you up during debugging.
        // Disable it during initialization so we always start from a known state.
        await this.encrypt();

        await this.setHighPower();
        await this.setMode(RfMode.Standby);
        this._interrupt.takeUntil(this._stop).concatMap(i => this.handleInterrupt()).subscribe();
    }

    async encrypt(key?: Buffer) {
        await this.setMode(RfMode.Standby);
        if (key !== void 0) {
            await this.transfer(c.REG_AESKEY1 | 0x80, ...key);
        }
        await this.updateReg(c.REG_PACKETCONFIG2, 0xFE, key === void 0 ? 0 : 1);
    }

    async setPowerLevel(powerLevel: number) {
        this._powerLevel = Math.min(31, Math.max(0, Math.round(powerLevel)));
        if (this._isRfm69Hw) { this._powerLevel = Math.floor(this._powerLevel / 2); }
        await this.updateReg(c.REG_PALEVEL, 0xE0, this._powerLevel);
    }

    async getFrequency() {
        const msb = await this.readReg(c.REG_FRFMSB);
        const mid = await this.readReg(c.REG_FRFMID);
        const lsb = await this.readReg(c.REG_FRFLSB);
        return RF69_FSTEP * ((msb << 16) + (mid << 8) + lsb);
    }

    async setFrequency(freqHz: number) {
        const oldMode = this._mode;
        if (oldMode === RfMode.Tx) {
            await this.setMode(RfMode.Rx);
        }

        freqHz /= Math.floor(RF69_FSTEP); // divide down by FSTEP to get FRF
        await this.writeReg(c.REG_FRFMSB, (freqHz >> 16) & 0xFF);
        await this.writeReg(c.REG_FRFMID, (freqHz >> 8) & 0xFF);
        await this.writeReg(c.REG_FRFLSB, freqHz & 0xFF);
        if (oldMode === RfMode.Rx) {
            await this.setMode(RfMode.Synth);
        }
        await this.setMode(oldMode);
    }

    async sleep() {
        await this.setMode(RfMode.Sleep);
    }

    send(to: number, data: Buffer) {
        return new Promise<void>((resolve, reject) => {
            this._sendQueue.next({
                data,
                reject,
                resolve,
                to,
            });
        });
    }

    private async setHighPower() {
        await this.writeReg(c.REG_OCP, this._isRfm69Hw ? c.RF_OCP_OFF : c.RF_OCP_ON);
        if (this._isRfm69Hw) {
            // enable P1 & P2 amplifier stages
            await this.updateReg(c.REG_PALEVEL, 0x1F, c.RF_PALEVEL_PA1_ON | c.RF_PALEVEL_PA2_ON);
        } else {
            // enable P0 only
            await this.writeReg(c.REG_PALEVEL, c.RF_PALEVEL_PA0_ON | c.RF_PALEVEL_PA1_OFF | c.RF_PALEVEL_PA2_OFF | this._powerLevel);
        }
    }

    private async setMode(newMode: RfMode) {
        if (newMode === this._mode) {
            return;
        }

        switch (newMode) {
            case RfMode.Tx:
                await this.updateReg(c.REG_OPMODE, 0xE3, c.RF_OPMODE_TRANSMITTER);
                if (this._isRfm69Hw) { await this.setHighPowerRegs(true); }
                break;
            case RfMode.Rx:
                await this.updateReg(c.REG_OPMODE, 0xE3, c.RF_OPMODE_RECEIVER);
                if (this._isRfm69Hw) { await this.setHighPowerRegs(false); }
                break;
            case RfMode.Synth:
                await this.updateReg(c.REG_OPMODE, 0xE3, c.RF_OPMODE_SYNTHESIZER);
                break;
            case RfMode.Standby:
                await this.updateReg(c.REG_OPMODE, 0xE3, c.RF_OPMODE_STANDBY);
                break;
            case RfMode.Sleep:
                await this.updateReg(c.REG_OPMODE, 0xE3, c.RF_OPMODE_SLEEP);
                break;
            default:
                return;
        }

        await this.waitFor(() => this.modeReady)
            .catch(err => Observable.throw(new RadioError('radio wait for mode ready timeout')))
            .toPromise();
        this._mode = newMode;
    }

    private async setHighPowerRegs(onOff: boolean) {
        await this.writeReg(c.REG_TESTPA1, onOff ? 0x5D : 0x55);
        await this.writeReg(c.REG_TESTPA2, onOff ? 0x7C : 0x70);
    }

    private waitFor(poll: () => Promise<boolean>, timeout = 50, interval = 2) {
        return Observable.interval(interval)
            .startWith(0)
            .concatMap(() => poll())
            .filter(done => done)
            .timeout(timeout);
    }

    private async setSyncAndWait(value: number) {
        await this.waitFor(
            async () => {
                await this.writeReg(c.REG_SYNCVALUE1, value);
                return await this.readReg(c.REG_SYNCVALUE1) !== value;
            })
            .catch(err => Observable.empty<boolean>())
            .toPromise();
    }

    private async transfer(...data: number[]): Promise<Buffer> {
        const buffer = Buffer.from(data);
        const read = await this._spi.transfer(buffer);
        return read;
    }

    private async readReg(address: number) {
        const [, reg] = await this.transfer(address & 0x7F, 0);
        return reg;
    }

    private async writeReg(address: number, value: number) {
        await this.transfer(address | 0x80, value);
    }

    private async updateReg(address: number, mask: number, set: number) {
        const value = await this.readReg(address);
        await this.writeReg(address, value & mask | set);
    }

    private async canSend() {
        if (this._mode === RfMode.Rx && await this.readRSSI() < -90) {
            // if signal stronger than -100dBm is detected assume channel activity
            await this.setMode(RfMode.Standby);
            return true;
        }

        return false;
    }

    private async sendInternal(to: number, data: Buffer) {
        if (data.length > 62) {
            throw new RadioError('radio packet size too big');
        }

        await this.rxRestart();

        await this.waitFor(() => this.canSend(), 500)
            .catch(() => Observable.empty())
            .toPromise();

        await this.setMode(RfMode.Standby); // turn off receiver to prevent reception while filling fifo
        await this.writeReg(c.REG_DIOMAPPING1, c.RF_DIOMAPPING1_DIO0_00); // DIO0 is "Packet Sent"

        // write to FIFO
        await this.transfer(c.REG_FIFO | 0x80, data.length + 2, to, this._nodeId, ...data);

        const waitForFirstInterrupt =
            this._interrupt
                .first()
                .timeout(50)
                .catch(() => Observable.throw(new RadioError('timeout while waiting for tx interrupt')))
                .toPromise();

        // no need to wait for transmit mode to be ready since its handled by the radio
        await this.setMode(RfMode.Tx);
        await waitForFirstInterrupt; // wait for DIO0 to turn HIGH signalling transmission finish
        await this.setMode(RfMode.Standby);
    }

    private async readRSSI(forceTrigger: boolean = false) {
        if (forceTrigger) {
            // RSSI trigger not needed if DAGC is in continuous mode
            await this.writeReg(c.REG_RSSICONFIG, c.RF_RSSI_START);
            await this.waitFor(() => this.rssiDone)
                .catch(err => Observable.throw(new RadioError('radio timeout while waiting for RSSI ready')))
                .toPromise();
        }
        const rssi = await this.readReg(c.REG_RSSIVALUE);
        return -rssi / 2;
    }

    private async receiveBegin() {
        if (await this.payloadReady) {
            await this.rxRestart();
        }
        await this.writeReg(c.REG_DIOMAPPING1, c.RF_DIOMAPPING1_DIO0_01); // set DIO0 to "PAYLOADREADY" in receive mode
        await this.setMode(RfMode.Rx);
    }

    private async rxRestart() {
        await this.updateReg(c.REG_PACKETCONFIG2, 0xFB, c.RF_PACKET2_RXRESTART); // avoid RX deadlocks
    }

    private async hasFlag(register: number, flag: number) {
        return (await this.readReg(register) & flag) !== 0;
    }

    private get payloadReady() {
        return this.hasFlag(c.REG_IRQFLAGS2, c.RF_IRQFLAGS2_PAYLOADREADY);
    }

    private get modeReady() {
        return this.hasFlag(c.REG_IRQFLAGS1, c.RF_IRQFLAGS1_MODEREADY);
    }

    private get rssiDone() {
        return this.hasFlag(c.REG_RSSICONFIG, c.RF_RSSI_DONE);
    }

    private get frMsb() {
        switch (this._band) {
            case RfBand.Rf315MHZ: return c.RF_FRFMSB_315;
            case RfBand.Rf433MHZ: return c.RF_FRFMSB_433;
            case RfBand.Rf868MHZ: return c.RF_FRFMSB_868;
            default: return c.RF_FRFMSB_915;
        }
    }

    private get frMid() {
        switch (this._band) {
            case RfBand.Rf315MHZ: return c.RF_FRFMID_315;
            case RfBand.Rf433MHZ: return c.RF_FRFMID_433;
            case RfBand.Rf868MHZ: return c.RF_FRFMID_868;
            default: return c.RF_FRFMID_915;
        }
    }

    private get frLsb() {
        switch (this._band) {
            case RfBand.Rf315MHZ: return c.RF_FRFLSB_315;
            case RfBand.Rf433MHZ: return c.RF_FRFLSB_433;
            case RfBand.Rf868MHZ: return c.RF_FRFLSB_868;
            default: return c.RF_FRFLSB_915;
        }
    }

    private async handleInterrupt() {
        if (this._mode === RfMode.Rx && await this.payloadReady) {
            // RSSI = readRSSI();
            await this.setMode(RfMode.Standby);

            const [, length, targetId, senderId, ctrlByte] = await this.transfer(c.REG_FIFO & 0x7F, 0, 0, 0, 0);
            const payloadLen = Math.min(length, 66);

            if (payloadLen < 3) {
                await this.receiveBegin();
            }

            const datalen = payloadLen - 2;
            const data = await this.transfer(c.REG_FIFO & 0x7F, ... new Array(datalen));
            await this.setMode(RfMode.Rx);

            const rssi = await this.readRSSI();
            this._data.next({
                data,
                from: senderId,
                rssi,
            });
        }
    }
}
