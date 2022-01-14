export class Base {
    public constructor(private className: string) { }

    protected log(...args: any[]): void {
        console.log(this.formatTimestamp(Date.now()), '|', this.formatClassName(), '|', ...args);
    }

    private formatClassName(): string {
        const CLASS_NAME_MAX_LENGTH: number = 17;

        return this.className + ' '.repeat(CLASS_NAME_MAX_LENGTH - this.className.length);
    }

    private formatTimestamp(msDate: number): string {
        if (!Boolean(msDate)) {
            return '';
        }

        const date: Date = new Date(msDate);
        const year: string = this.prefixWithZero(date.getUTCFullYear());
        const month: string = this.prefixWithZero(date.getUTCMonth() + 1);
        const day: string = this.prefixWithZero(date.getUTCDate());
        const hours: string = this.prefixWithZero(date.getUTCHours());
        const minutes: string = this.prefixWithZero(date.getUTCMinutes());
        const seconds: string = this.prefixWithZero(date.getUTCSeconds());
        const msDateString: string = msDate.toString();
        const milliseconds: string = this.prefixWithZero(Number(msDateString.substring(msDateString.length - 3)), 100);

        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    protected prefixWithZero(number: number, radix: number = 10): string {
        let prefixed: string = '';

        while (radix > 1 && number < radix) {
            prefixed += '0';
            radix /= 10;
        }

        return prefixed + number;
    }

    public static round(value: number, decimals: number = 0): number {
        return +(Math.round(<any>(value + 'e+' + decimals)) + 'e-' + decimals);
    }
}
