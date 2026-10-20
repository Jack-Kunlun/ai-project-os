export type InquiryBox={left:number;right:number;top:number;width:number;height:number};
export function inquiryPlacement(box:InquiryBox,viewport:{width:number;height:number},wide=false){
 const width=wide?650:450,gap=16;
 if(box.left>=width+gap*2)return {mode:'beside' as const,left:box.left-gap-width,top:Math.max(16,box.top),width};
 if(viewport.width-box.right>=width+gap*2)return {mode:'beside' as const,left:box.right+gap,top:Math.max(16,box.top),width};
 return {mode:'body' as const};
}
