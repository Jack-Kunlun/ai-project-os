import { randomInt } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
// Fixed bitmap alphabet avoids depending on fonts in the production container.
const glyphs: Record<string, string> = {
 A:"01110/10001/10001/11111/10001/10001/10001", B:"11110/10001/10001/11110/10001/10001/11110",
 C:"01111/10000/10000/10000/10000/10000/01111", D:"11110/10001/10001/10001/10001/10001/11110",
 E:"11111/10000/10000/11110/10000/10000/11111", F:"11111/10000/10000/11110/10000/10000/10000",
 G:"01111/10000/10000/10111/10001/10001/01111", H:"10001/10001/10001/11111/10001/10001/10001",
 J:"00111/00010/00010/00010/10010/10010/01100", K:"10001/10010/10100/11000/10100/10010/10001",
 L:"10000/10000/10000/10000/10000/10000/11111", M:"10001/11011/10101/10101/10001/10001/10001",
 N:"10001/11001/10101/10011/10001/10001/10001", P:"11110/10001/10001/11110/10000/10000/10000",
 Q:"01110/10001/10001/10001/10101/10010/01101", R:"11110/10001/10001/11110/10100/10010/10001",
 S:"01111/10000/10000/01110/00001/00001/11110", T:"11111/00100/00100/00100/00100/00100/00100",
 U:"10001/10001/10001/10001/10001/10001/01110", V:"10001/10001/10001/10001/10001/01010/00100",
 W:"10001/10001/10001/10101/10101/11011/10001", X:"10001/10001/01010/00100/01010/10001/10001",
 Y:"10001/10001/01010/00100/00100/00100/00100", Z:"11111/00001/00010/00100/01000/10000/11111",
 "2":"01110/10001/00001/00010/00100/01000/11111", "3":"11110/00001/00001/01110/00001/00001/11110",
 "4":"00010/00110/01010/10010/11111/00010/00010", "5":"11111/10000/10000/11110/00001/00001/11110",
 "6":"01110/10000/10000/11110/10001/10001/01110", "7":"11111/00001/00010/00100/01000/01000/01000",
 "8":"01110/10001/10001/01110/10001/10001/01110", "9":"01110/10001/10001/01111/00001/00001/01110",
};
export const CAPTCHA_ALPHABET = Object.keys(glyphs).join("");
export function newCaptchaAnswer(): string { return Array.from({length:6},()=>CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)]).join(""); }
export async function renderGraphicCaptcha(answer: string): Promise<Buffer> {
 if (answer.length!==6 || [...answer].some(c=>!glyphs[c])) throw new Error("CAPTCHA_IMAGE_INPUT_INVALID");
 const canvas=createCanvas(216,72),ctx=canvas.getContext("2d");
 ctx.fillStyle="#f1f5f9";ctx.fillRect(0,0,216,72);
 for(let i=0;i<90;i++){ctx.fillStyle=`rgba(71,85,105,${randomInt(10,36)/100})`;ctx.fillRect(randomInt(216),randomInt(72),2,2);}
 for(let i=0;i<5;i++){ctx.strokeStyle="#b6c3d8";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,randomInt(72));ctx.bezierCurveTo(60,randomInt(72),150,randomInt(72),216,randomInt(72));ctx.stroke();}
 [...answer].forEach((char,index)=>{ctx.save();ctx.translate(9+index*34+randomInt(3),14+randomInt(8));ctx.rotate(randomInt(-12,13)*Math.PI/180);ctx.fillStyle=["#243869","#323284","#18535e"][randomInt(3)];glyphs[char].split("/").forEach((row,y)=>[...row].forEach((pixel,x)=>{if(pixel==="1")ctx.fillRect(x*4.5,y*5,4.8,5.3);}));ctx.restore();});
 return canvas.encode("png");
}
