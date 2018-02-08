import { Radio } from './Radio';
import { RadioConfig } from './RadioConfig';
import { RadioError } from './RadioError';
import { RfBand } from './RfBand';
import { RfMode } from './RfMode';
import { Spi } from './Spi';

export { Spi, Radio, RadioConfig, RadioError, RfBand, RfMode };

// import { Subject } from 'rxjs/Subject';
// function* spiMock() {
//     yield Buffer.from([]);
//     yield Buffer.from([, 0xAA]);
//     yield Buffer.from([]);
//     yield Buffer.from([, 0x55]);
// }

// let iterator = spiMock();

// const radio = new Radio({
//     transfer: async (data) => {
//         console.log(data.toString('hex'));
//         if (iterator) {
//             const result = iterator.next();
//             if (result.done) { iterator = undefined; }
//             return result.value;
//         }
//         return data;
//     },
// }, new Subject());

// async function test() {
//     await radio.init();
// }

// test();
