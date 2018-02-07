export class RadioError extends Error {
    constructor(m: string) {
        super(m);
        Object.setPrototypeOf(this, RadioError.prototype);
    }
}
