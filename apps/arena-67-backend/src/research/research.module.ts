import { Module } from '@nestjs/common';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';
import { AnalysisController } from './analysis.controller';
import { ReportService } from './report.service';
import { VolumeService } from './volume.service';

@Module({
  controllers: [ResearchController, AnalysisController],
  providers: [ResearchService, ReportService, VolumeService],
  exports: [ResearchService, ReportService, VolumeService],
})
export class ResearchModule {}
