import type { PhotoSemanticAnalysis } from "@/lib/schemas/analysis";

export type TechnicalScores = {
  sharpness:number; exposure:number; contrast:number; colorBalance:number; resolution:number;
  noise:number; clipping:number; overall:number;
};

export type PhotoRecord = {
  id:string; hash:string; sourcePath:string; workingPath:string; analysisPath:string;
  width:number; height:number; captureTime?:string; camera?:string; gps?:{lat:number;lon:number};
  technical:TechnicalScores; perceptualHash:string; duplicateOf?:string; similarityCluster?:string;
  semantic?:PhotoSemanticAnalysis; rejectionReasons:string[];
};
