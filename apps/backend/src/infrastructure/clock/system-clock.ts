import { Injectable } from '@nestjs/common';
import { Clock } from '@domain-services/platform/clock';

/** O relógio do processo. Ver a porta em domain-services/platform/clock.ts. */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
