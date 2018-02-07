import { RfBand } from './RfBand';

export interface RadioConfig {
    nodeId?: number;
    networkId?: number;
    band?: RfBand;
    isRfm69Hw?: boolean;
}
