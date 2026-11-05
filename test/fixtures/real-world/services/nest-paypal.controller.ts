// Decorators must parse, and a NestJS webhook method must be seen.
import { Controller, Post, Req } from '@nestjs/common';

@Controller('paypal')
export class PaypalController {
  @Post('webhook')
  async onEvent(@Req() req: { body: { event_type: string; resource: { id: string } } }) {
    if (req.body.event_type === 'PAYMENT.CAPTURE.COMPLETED') return { paid: req.body.resource.id };
    return {};
  }
}
