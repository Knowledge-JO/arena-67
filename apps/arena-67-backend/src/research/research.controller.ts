import { Controller, Get } from '@nestjs/common';
import { ResearchService } from './research.service';

@Controller('research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Get('trending')
  trending() {
    return this.research.snapshot();
  }
}
