// =============================================================================
// GRID-SLIDE.JS — Slide Grid Detection (hole-aligned anchor method)
// =============================================================================
//
// Self-contained module for the "slide" grid detection method.
// Uses connected component clustering + hole topology alignment
// for robust scoresheet digitization without perspective warping.
//
// Pipeline: smartCrop → CC detection → clustering → scoring →
//           quality-gated merge → header/footer classification →
//           hole-based sliding-window alignment → direct mini-warp extraction
//
// Dependencies: OpenCV.js (cv global)
// Export: window.SlideGrid
//
// IMPORTANT: This method produces NO header row (starts at move 1).
//            The legacy contour method includes White/Black headers.
// =============================================================================

(function() {
'use strict';

// =============================================================================
// SMART CROP & COLOR STRIPPING
// =============================================================================

function smartCrop(grayMat) {
    // Auto-crop to content area if there's significant whitespace
    var H = grayMat.rows, W = grayMat.cols;
    var bin = new cv.Mat();
    // High threshold catches even light gray; BINARY_INV: dark pixels → 255
    cv.threshold(grayMat, bin, 230, 255, cv.THRESH_BINARY_INV);

    // Clear outermost 2% border (scanner edge shadow/artifacts)
    var brd = Math.max(8, Math.round(Math.min(H, W) * 0.02));
    cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(W, brd), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(0, H - brd), new cv.Point(W, H), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(brd, H), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(W - brd, 0), new cv.Point(W, H), new cv.Scalar(0), -1);

    // Close only (no open) — bridges nearby content, preserves thin strokes
    var kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose); kClose.delete();

    // Debug: count ink pixels
    var nz = cv.countNonZero(bin);
    log('[SmartCrop] '+W+'x'+H+' thresh=230 border='+brd+'px ink='+nz+' ('+(nz/(H*W)*100).toFixed(1)+'%)','dim');

    if (nz === 0) {
        bin.delete();
        log('[SmartCrop] No ink found — no crop', 'dim');
        return { x: 0, y: 0, w: W, h: H, cropped: false };
    }

    // Find bounding box via row/col projections (avoids findNonZero memory issues)
    var rowProj = new cv.Mat(), colProj = new cv.Mat();
    cv.reduce(bin, rowProj, 1, cv.REDUCE_MAX); // Hx1: max across each row
    cv.reduce(bin, colProj, 0, cv.REDUCE_MAX); // 1xW: max across each col

    var top = 0, bot = H - 1, left = 0, right = W - 1;
    while (top < H && rowProj.ucharAt(top, 0) === 0) top++;
    while (bot > top && rowProj.ucharAt(bot, 0) === 0) bot--;
    while (left < W && colProj.ucharAt(0, left) === 0) left++;
    while (right > left && colProj.ucharAt(0, right) === 0) right--;
    rowProj.delete(); colProj.delete(); bin.delete();

    var br = { x: left, y: top, width: right - left + 1, height: bot - top + 1 };

    // Add margin (3% of content size, min 10px)
    var mY = Math.max(10, Math.round(br.height * 0.03));
    var mX = Math.max(10, Math.round(br.width * 0.03));
    var top = Math.max(0, br.y - mY);
    var left = Math.max(0, br.x - mX);
    var bot = Math.min(H, br.y + br.height + mY);
    var right = Math.min(W, br.x + br.width + mX);
    var contentW = right - left, contentH = bot - top;

    var usedPct = Math.round(contentH * contentW / (H * W) * 100);
    log('[SmartCrop] Ink bounds: x='+br.x+'..'+Math.round(br.x+br.width)+' y='+br.y+'..'+Math.round(br.y+br.height)+' → '+contentW+'x'+contentH+' ('+usedPct+'% of '+W+'x'+H+')','dim');

    if (usedPct < 90) {
        log('[SmartCrop] Content uses ' + usedPct + '% of image → cropping from ' + W + 'x' + H + ' to ' + contentW + 'x' + contentH, 'good');
        return { x: left, y: top, w: contentW, h: contentH, cropped: true };
    } else {
        log('[SmartCrop] Content uses ' + usedPct + '% — no crop needed', 'dim');
        return { x: 0, y: 0, w: W, h: H, cropped: false };
    }
}


function stripColoredMarks(rgbaMat, satThreshold) {
    // Remove colored annotations by whiting out high-saturation pixels.
    var bgr = new cv.Mat();
    cv.cvtColor(rgbaMat, bgr, cv.COLOR_RGBA2BGR);
    var hsv = new cv.Mat();
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    bgr.delete();
    var channels = new cv.MatVector();
    cv.split(hsv, channels);
    var satCh = channels.get(1), valCh = channels.get(2);
    var satMask = new cv.Mat();
    cv.threshold(satCh, satMask, satThreshold, 255, cv.THRESH_BINARY);
    var darkMask = new cv.Mat();
    cv.threshold(valCh, darkMask, 60, 255, cv.THRESH_BINARY);
    cv.bitwise_and(satMask, darkMask, satMask);
    var kD = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(satMask, satMask, kD); kD.delete();
    var cnt = cv.countNonZero(satMask);
    var pct = (cnt / (rgbaMat.rows * rgbaMat.cols) * 100).toFixed(1);
    var result = rgbaMat.clone();
    var white = new cv.Mat(result.rows, result.cols, result.type(), new cv.Scalar(255, 255, 255, 255));
    white.copyTo(result, satMask); white.delete();
    satCh.delete(); valCh.delete(); channels.delete();
    hsv.delete(); satMask.delete(); darkMask.delete();
    log('[ColorFilter] sat>'+satThreshold+': removed '+cnt+' px ('+pct+'%)','dim');
    return { cleaned: result, removedPct: parseFloat(pct) };
}

// =============================================================================
// CONNECTED COMPONENT CANDIDATE DETECTION
// =============================================================================

function findCandidates(grayMat,opts){
    var H=grayMat.rows,W=grayMat.cols,minH=Math.round(H*(opts.minHR||0.008)),maxH=Math.round(H*(opts.maxHR||0.04));
    var maxW=Math.round(W*(opts.maxWR||0.025)); // max width as % of image width
    var bs=Math.round(H*(opts.blockPct||2)/100);if(bs%2===0)bs++;if(bs<3)bs=3;
    var bin=new cv.Mat();cv.adaptiveThreshold(grayMat,bin,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY_INV,bs,8);
    var k=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(2,2));var cl=new cv.Mat();cv.morphologyEx(bin,cl,cv.MORPH_CLOSE,k);k.delete();
    var lb=new cv.Mat(),st=new cv.Mat(),ct=new cv.Mat();var n=cv.connectedComponentsWithStats(cl,lb,st,ct,8);
    var cands=[],rTooSmall=0,rTooBig=0,rTooWide=0,rTooTall=0,rTooNarrow=0,rTooSparse=0;
    // Diagnostic: track size distributions of rejected CCs
    var acceptedHs=[],rejWideHs=[],rejTallHs=[];
    for(var i=1;i<n;i++){var x=st.intAt(i,cv.CC_STAT_LEFT),y=st.intAt(i,cv.CC_STAT_TOP),w=st.intAt(i,cv.CC_STAT_WIDTH),h=st.intAt(i,cv.CC_STAT_HEIGHT),a=st.intAt(i,cv.CC_STAT_AREA);
        if(h<minH){rTooSmall++;continue;}
        if(h>maxH){rTooBig++;continue;}
        if(w>maxW){rTooTall++;rejTallHs.push(h);continue;} // width filter (using maxW)
        if(w/h>1.8){rTooWide++;rejWideHs.push(h);continue;}
        if(w/h<0.08){rTooNarrow++;continue;}
        if(a/(w*h)<0.15){rTooSparse++;continue;}
        cands.push({x:x,y:y,w:w,h:h,cx:ct.doubleAt(i,0),cy:ct.doubleAt(i,1),area:a});
        acceptedHs.push(h);}
    log('[CC] '+(n-1)+' components → '+cands.length+' candidates','dim');
    log('  Filters: H:'+minH+'-'+maxH+'px, maxW:'+maxW+'px ('+Math.round(maxW/W*100*10)/10+'%)','dim');
    log('  Reject: small='+rTooSmall+' big='+rTooBig+' wide(ar)='+rTooWide+' wide(abs)='+rTooTall+' narrow='+rTooNarrow+' sparse='+rTooSparse,'dim');
    // Size distribution of accepted CCs
    if(acceptedHs.length>0){
        acceptedHs.sort(function(a,b){return a-b;});
        var medH=acceptedHs[Math.floor(acceptedHs.length/2)];
        var p10=acceptedHs[Math.floor(acceptedHs.length*0.1)];
        var p90=acceptedHs[Math.floor(acceptedHs.length*0.9)];
        log('  Accepted heights: min='+acceptedHs[0]+' p10='+p10+' med='+medH+' p90='+p90+' max='+acceptedHs[acceptedHs.length-1],'dim');
    }
    if(rejTallHs.length>0){
        rejTallHs.sort(function(a,b){return a-b;});
        log('  Rejected(wide): '+rejTallHs.length+' CCs, heights: '+rejTallHs[0]+'-'+rejTallHs[rejTallHs.length-1],'dim');
    }
    lb.delete();st.delete();ct.delete();return{cands:cands,binary:bin,cleaned:cl};
}

// =============================================================================
// SINGLE-LINKAGE CLUSTERING
// =============================================================================

function singleLinkageClustering(cands,xW){
    var n=cands.length,edges=[];
    for(var i=0;i<n;i++)for(var j=i+1;j<n;j++){var dx=(cands[i].cx-cands[j].cx)*xW,dy=cands[i].cy-cands[j].cy;edges.push({i:i,j:j,dist:Math.sqrt(dx*dx+dy*dy)});}
    edges.sort(function(a,b){return a.dist-b.dist;});
    var p=new Array(n),rk=new Array(n),sz=new Array(n);for(var k=0;k<n;k++){p[k]=k;rk[k]=0;sz[k]=1;}
    function find(x){while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return false;if(rk[a]<rk[b]){var t=a;a=b;b=t;}p[b]=a;sz[a]+=sz[b];if(rk[a]===rk[b])rk[a]++;return true;}
    var hist=[],nc=n;for(var ei=0;ei<edges.length;ei++){var e=edges[ei];if(find(e.i)!==find(e.j)){union(e.i,e.j);nc--;hist.push({dist:e.dist,nc:nc});}}
    return{hist:hist,edges:edges,n:n};
}

function extractClustersAtN(cands,edges,tgt){
    var n=cands.length,p=new Array(n),rk=new Array(n),sz=new Array(n);for(var k=0;k<n;k++){p[k]=k;rk[k]=0;sz[k]=1;}
    function find(x){while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return false;if(rk[a]<rk[b]){var t=a;a=b;b=t;}p[b]=a;sz[a]+=sz[b];if(rk[a]===rk[b])rk[a]++;return true;}
    var nc=n;for(var ei=0;ei<edges.length&&nc>tgt;ei++){if(find(edges[ei].i)!==find(edges[ei].j)){union(edges[ei].i,edges[ei].j);nc--;}}
    var m={};for(var ci=0;ci<n;ci++){var r=find(ci);if(!m[r])m[r]=[];m[r].push(cands[ci]);}
    var cls=Object.values(m);cls.sort(function(a,b){return b.length-a.length;});return cls;
}

// =============================================================================
// CLUSTER SCORING (with height consistency, gap-multiple, row penalty)
// =============================================================================

function scoreCluster(cl,H,W,maxWP,rowCount){
    if(cl.length<5)return{score:0,reason:'small('+cl.length+')'};
    var xs=cl.map(function(c){return c.cx;}),ys=cl.map(function(c){return c.cy;});
    var xMn=Math.min.apply(null,xs),xMx=Math.max.apply(null,xs),yMn=Math.min.apply(null,ys),yMx=Math.max.apply(null,ys);
    var w=xMx-xMn+1,h=yMx-yMn+1;
    if(w>W*maxWP/100)return{score:0,reason:'wide('+w.toFixed(0)+')'};
    // Scale minimum height by rowCount (20 rows = 30%, 15 rows = 22.5%, 10 rows = 15%)
    var minHPct = 0.15 * (rowCount || 20) / 20;
    if(h<H*minHPct)return{score:0,reason:'short('+Math.round(h/H*100)+'%<'+Math.round(minHPct*100)+'%)'};
    ys.sort(function(a,b){return a-b;});var sp=[];for(var i=1;i<ys.length;i++)sp.push(ys[i]-ys[i-1]);
    var rsp=sp.filter(function(s){return s>h*0.02;}),ss=0,rowEst=0;
    if(rsp.length>=5){var med=rsp.slice().sort(function(a,b){return a-b;})[Math.floor(rsp.length/2)];var reg=rsp.filter(function(s){return s>med*0.5&&s<med*1.8;});ss=reg.length/rsp.length;rowEst=Math.round(h/med)+1;}
    // X-tightness: printed number columns have very tight x-spread (low stdev)
    var xMean=xs.reduce(function(s,v){return s+v;},0)/xs.length;
    var xVar=xs.reduce(function(s,v){return s+Math.pow(v-xMean,2);},0)/xs.length;
    var xStd=Math.sqrt(xVar);
    var xStdPct=xStd/W;
    var xTight=1-Math.min(1,Math.max(0,(xStdPct-0.008)/0.025));

    // Height consistency: components should have similar heights (same font)
    var hs=cl.map(function(c){return c.h;});
    hs.sort(function(a,b){return a-b;});
    var medH=hs[Math.floor(hs.length/2)];
    var hVar=hs.reduce(function(s,v){return s+Math.pow(v-medH,2);},0)/hs.length;
    var hStd=Math.sqrt(hVar);
    var hConsistency=Math.max(0, 1 - hStd/Math.max(1,medH));

    // Spacing gap-multiple check: gaps should be clean integer multiples of base spacing
    var gapMultipleScore = 0;
    if(rsp.length>=5){
        var medSp=rsp.slice().sort(function(a,b){return a-b;})[Math.floor(rsp.length/2)];
        var goodGaps=0;
        for(var gi=0;gi<rsp.length;gi++){
            var ratio=rsp[gi]/medSp;
            var nearest=Math.round(ratio);
            if(nearest>=1&&nearest<=3&&Math.abs(ratio-nearest)<0.3) goodGaps++;
        }
        gapMultipleScore=goodGaps/rsp.length;
    }

    var ar=h/Math.max(1,w),sf=Math.min(cl.length,50)/50,idealH=H*0.6*(rowCount||20)/20,hf=Math.min(h/idealH,1.0);

    // Row overshoot penalty: clusters estimating far more rows than expected are likely noise
    var rowPenalty = 1;
    if(rowCount && rowEst > 0) {
        var rowRatio = rowEst / rowCount;
        if(rowRatio > 1.4) {
            // 1.4x → mild, 2x+ → heavy (1/ratio^2)
            rowPenalty = Math.max(0.15, 1.0 / (rowRatio * rowRatio));
        }
    }

    var score=ar*sf*hf*(0.5+0.5*ss)*(0.5+0.5*xTight)*(0.6+0.4*hConsistency)*(0.6+0.4*gapMultipleScore)*rowPenalty;
    return{score:score,width:w,height:h,aspectRatio:ar,spacingScore:ss,rowEstimate:rowEst,xStd:Math.round(xStd),xTight:Math.round(xTight*100)/100,hConsistency:Math.round(hConsistency*100)/100,gapMultipleScore:Math.round(gapMultipleScore*100)/100,rowPenalty:Math.round(rowPenalty*100)/100,reason:'ok'};
}

// =============================================================================
// AUTO-FIND BEST CUT (row accuracy bonus)
// =============================================================================

function autoFindBestCut(cands,edges,H,W,expCols,maxWP,rowCount){
    var best=-1,bestN=2,bestD=null,maxN=Math.min(cands.length,120);
    var mergeT=W*0.04; // same merge threshold as pipeline
    var dbg={tried:0,noScore:0,badRows:0,tooClose:0,tooNarrow:0,badHtR:0,scored:0};
    for(var t=maxN;t>=2;t--){
        dbg.tried++;
        var cls=extractClustersAtN(cands,edges,t);
        var sc=cls.map(function(c){return{cluster:c,scoring:scoreCluster(c,H,W,maxWP,rowCount)};});
        sc.sort(function(a,b){return b.scoring.score-a.scoring.score;});
        var top=sc.slice(0,expCols);
        if(top.length<expCols||!top.every(function(s){return s.scoring.score>0;})){dbg.noScore++;continue;}

        // Row count check: each column should estimate close to rowCount rows
        // Allow up to 4 missing (players sometimes overwrite/destroy move numbers)
        if(rowCount) {
            var minRows = Math.max(Math.round(rowCount * 0.4), 5);
            var rowsOK = top.every(function(s){
                return s.scoring.rowEstimate >= minRows;
            });
            if(!rowsOK){dbg.badRows++;continue;}
        }

        // Check X-separation: columns must be far apart (not mergeable)
        var cxs=top.map(function(s){
            return s.cluster.reduce(function(sum,c){return sum+c.cx;},0)/s.cluster.length;
        });
        cxs.sort(function(a,b){return a-b;});
        var tooClose=false;
        for(var ci=1;ci<cxs.length;ci++){
            if(cxs[ci]-cxs[ci-1]<mergeT*2){tooClose=true;break;}
        }
        if(tooClose){dbg.tooClose++;continue;}

        var xSpread=cxs[cxs.length-1]-cxs[0];
        if(xSpread < W*0.15){dbg.tooNarrow++;continue;}

        var cs=top.reduce(function(s,t2){return s+t2.scoring.score;},0);
        var szs=top.map(function(s){return s.cluster.length;});
        cs*=(0.5+0.5*Math.min.apply(null,szs)/Math.max.apply(null,szs));
        // Bonus for columns closer to expected rowCount (penalizes both under AND overshoot)
        if(rowCount) {
            var rowAccuracy = top.reduce(function(sum,s){
                var ratio = s.scoring.rowEstimate / rowCount;
                // Perfect=1.0, undershoot and overshoot both reduce score
                return sum + Math.max(0, 1 - Math.abs(ratio - 1) * 0.7);
            }, 0) / top.length;
            cs *= (0.5 + 0.5 * rowAccuracy);
        }
        var hts=top.map(function(s){return s.scoring.height||0;});
        if(hts.every(function(h2){return h2>0;})){
            var htR=Math.min.apply(null,hts)/Math.max.apply(null,hts);
            if(htR<0.7){dbg.badHtR++;continue;}
            cs*=(0.5+0.5*htR);
        }
        dbg.scored++;
        if(cs>best){best=cs;bestN=t;bestD=top;}
    }
    log('  AutoFind: tried='+dbg.tried+' scored='+dbg.scored+' (reject: noScore='+dbg.noScore+' badRows='+dbg.badRows+' tooClose='+dbg.tooClose+' tooNarrow='+dbg.tooNarrow+' badHtRatio='+dbg.badHtR+')','dim');
    return{bestN:bestN,bestScore:best,details:bestD};
}

// =============================================================================
// ROW BUILDING FROM CLUSTER
// =============================================================================

function buildRowsFromCluster(cluster, rowCount) {
    cluster.sort(function(a,b){return a.cy-b.cy;});
    var avgH = cluster.reduce(function(s,c){return s+c.h;},0)/cluster.length;
    var yTol = avgH * 0.6;
    var groups = [[cluster[0]]];
    for (var i = 1; i < cluster.length; i++) {
        var last = groups[groups.length-1];
        if (cluster[i].cy - last[last.length-1].cy <= yTol) last.push(cluster[i]);
        else groups.push([cluster[i]]);
    }
    var rows = groups.map(function(g) {
        return {
            y: g.reduce(function(s,c){return s+c.cy;},0)/g.length,
            x: g.reduce(function(s,c){return s+c.cx;},0)/g.length,
            left: Math.min.apply(null,g.map(function(c){return c.x;})),
            right: Math.max.apply(null,g.map(function(c){return c.x+c.w;})),
            top: Math.min.apply(null,g.map(function(c){return c.y;})),
            bottom: Math.max.apply(null,g.map(function(c){return c.y+c.h;})),
            count: g.length
        };
    });
    if (rows.length >= 3) {
        var sps = []; for (var j=1;j<rows.length;j++) sps.push(rows[j].y-rows[j-1].y);
        var med = sps.slice().sort(function(a,b){return a-b;})[Math.floor(sps.length/2)];
        var expanded = [rows[0]];
        for (var k=1;k<rows.length;k++) {
            var gap = rows[k].y - rows[k-1].y;
            if (gap > med*1.6 && gap < med*2.5) {
                expanded.push({ y:(rows[k-1].y+rows[k].y)/2, x:(rows[k-1].x+rows[k].x)/2,
                    left:(rows[k-1].left+rows[k].left)/2, right:(rows[k-1].right+rows[k].right)/2,
                    interpolated:true, count:0 });
            }
            expanded.push(rows[k]);
        }
        rows = expanded;
    }
    if (rows.length > rowCount) rows = rows.slice(rows.length - rowCount);
    return rows;
}

// =============================================================================
// CLUSTER VALIDATION & CLEANING — remove header contamination, validate spacing
// =============================================================================
// Move number columns have a strong fingerprint:
//   - Nearly uniform y-spacing (periodic)
//   - Consistent component heights (same font size)
//   - Width signature: single-digit (1-9) narrow, double-digit (10+) wider
//   - "#", "White", "Black" headers have wrong height/width/spacing
//
// This function removes contaminants and validates the cluster BEFORE row building.

// =============================================================================
// HOLE DETECTION — topological feature for digit identification
// =============================================================================
// Digits with holes:  0(1), 4(1), 6(1), 8(2), 9(1)
// Digits without:     1(0), 2(0), 3(0), 5(0), 7(0)
// Special: "#" has 0 holes (it's lines, not enclosed areas — unless font-dependent)
//
// Usage: diagnostic only for now. Count Euler holes in each CC of the number columns.

/**
 * Count the number of holes in a single connected component.
 * Uses the topological approach: pad the CC crop with background, invert,
 * count connected components. Holes = total_regions - 2 (background + outer).
 *
 * @param {cv.Mat} binaryMat - Binary image (ink=255, bg=0) from adaptive threshold
 * @param {Object} cc - Candidate {x, y, w, h, cx, cy}
 * @returns {number} Number of holes (0, 1, or 2 typically)
 */

// =============================================================================
// HOLE TOPOLOGY ANALYSIS
// =============================================================================

function countCCHoles(binaryMat, cc) {
    try {
        var H = binaryMat.rows, W = binaryMat.cols;

        // Expand bounding box by a margin so grid lines passing through
        // extend BEYOND the crop edge (and thus don't create false enclosures).
        var margin = Math.max(3, Math.round(Math.max(cc.w, cc.h) * 0.15));
        var x1 = Math.max(0, cc.x - margin);
        var y1 = Math.max(0, cc.y - margin);
        var x2 = Math.min(W, cc.x + cc.w + margin);
        var y2 = Math.min(H, cc.y + cc.h + margin);

        var roi = binaryMat.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));

        // Pad with 1px black border (ensures outer background is connected)
        var padded = new cv.Mat();
        cv.copyMakeBorder(roi, padded, 1, 1, 1, 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
        roi.delete();

        // Invert: ink→0 (black), background→255 (white)
        var inv = new cv.Mat();
        cv.bitwise_not(padded, inv);
        padded.delete();

        // Count connected components on inverted image
        var labels = new cv.Mat();
        var stats = new cv.Mat();
        var centroids = new cv.Mat();
        var numLabels = cv.connectedComponentsWithStats(inv, labels, stats, centroids);

        // Filter holes by area: real digit holes (in 0,4,6,8,9) occupy a significant
        // fraction of the CC area. Tiny "Swiss cheese" holes from grainy prints are noise.
        // Minimum hole area = 5% of CC area (or 20px², whichever is larger)
        var ccArea = cc.w * cc.h;
        var minHoleArea = Math.max(20, ccArea * 0.05);
        var realHoles = 0;
        // Label 0 = background of inverted image (i.e. ink)
        // Label 1+ = white regions; the largest is the outer background
        var maxArea = 0, outerLabel = 1;
        for (var li = 1; li < numLabels; li++) {
            var area = stats.intAt(li, cv.CC_STAT_AREA);
            if (area > maxArea) { maxArea = area; outerLabel = li; }
        }
        // Count remaining white regions that are large enough to be real holes
        for (var li = 1; li < numLabels; li++) {
            if (li === outerLabel) continue;
            var area = stats.intAt(li, cv.CC_STAT_AREA);
            if (area >= minHoleArea) realHoles++;
        }

        labels.delete(); stats.delete(); centroids.delete(); inv.delete();
        return realHoles;
    } catch (e) {
        return -1; // error
    }
}

function analyzeRowHoles(binaryMat, group) {
    var sorted = group.slice().sort(function(a,b) { return a.cx - b.cx; });
    var holes = sorted.map(function(cc) { return countCCHoles(binaryMat, cc); });
    var signature = holes.join(',');
    var totalHoles = holes.reduce(function(s,h){return s+h;}, 0);

    // Width ratio of entire row-group
    var minX = Math.min.apply(null, sorted.map(function(c){return c.x;}));
    var maxX = Math.max.apply(null, sorted.map(function(c){return c.x + c.w;}));
    var medH = sorted.map(function(c){return c.h;}).sort(function(a,b){return a-b;})[Math.floor(sorted.length/2)];
    var totalW = maxX - minX;
    var widthRatio = totalW / Math.max(1, medH);
    var isMerged = (sorted.length === 1 && widthRatio > 0.85);

    function shortG(hc) { return hc===0?'1237':hc===1?'0469':hc===2?'8':'?'; }
    var guess = '';
    if (sorted.length === 1) {
        if (isMerged) guess = 'merged(' + holes[0] + 'h)';
        else if (holes[0] >= 0 && holes[0] <= 2) guess = shortG(holes[0]);
        else guess = '?(' + holes[0] + 'h)';
    } else if (sorted.length === 2) {
        guess = '[' + shortG(holes[0]) + '][' + shortG(holes[1]) + ']';
    } else if (sorted.length === 3) {
        guess = '[' + shortG(holes[0]) + '][' + shortG(holes[1]) + '][' + shortG(holes[2]) + ']';
    }

    return {holes:holes, signature:signature, digitGuess:guess, nCCs:sorted.length,
            totalHoles:totalHoles, widthRatio:Math.round(widthRatio*100)/100, isMerged:isMerged};
}

// =============================================================================
// HOLE-BASED GRID ALIGNMENT (sliding window)
// =============================================================================

var DIGIT_HOLES = [1, 0, 0, 0, 1, 0, 1, 0, 2, 1];

function expectedHoles(num) {
    if (num < 1 || num > 999) return {total: 0, perDigit: []};
    if (num < 10) { var h = DIGIT_HOLES[num]; return {total: h, perDigit: [h]}; }
    if (num < 100) {
        var d1 = Math.floor(num / 10), d2 = num % 10;
        return {total: DIGIT_HOLES[d1] + DIGIT_HOLES[d2], perDigit: [DIGIT_HOLES[d1], DIGIT_HOLES[d2]]};
    }
    var d1 = Math.floor(num / 100), d2 = Math.floor((num % 100) / 10), d3 = num % 10;
    return {total: DIGIT_HOLES[d1] + DIGIT_HOLES[d2] + DIGIT_HOLES[d3], perDigit: [DIGIT_HOLES[d1], DIGIT_HOLES[d2], DIGIT_HOLES[d3]]};
}

function scoreHoleMatch(observed, expectedNum) {
    var exp = expectedHoles(expectedNum);
    var nCCs = observed.nCCs || observed.holes.length;
    var holes = observed.holes;
    if (nCCs === 0) return 0;

    // Anomalous holes (3+) are almost certainly noise — give minimal score
    var hasAnomaly = holes.some(function(h){return h > 2;});

    // Case 1: 2 CCs, double-digit number -> per-digit comparison
    if (nCCs === 2 && expectedNum >= 10) {
        if (hasAnomaly) return 0.2;  // something detected, but noisy
        var s1 = (holes[0] === exp.perDigit[0]) ? 1.0 : 0;
        var s2 = (holes[1] === exp.perDigit[1]) ? 1.0 : 0;
        return s1 + s2;
    }

    // Case 2: 1 CC, single-digit number -> direct comparison
    if (nCCs === 1 && expectedNum < 10) {
        if (hasAnomaly) return 0.1;
        return (holes[0] === exp.perDigit[0]) ? 2.0 : 0;
    }

    // Case 3: 1 CC, double-digit number
    if (nCCs === 1 && expectedNum >= 10) {
        if (hasAnomaly) return 0.1;
        var wr = observed.widthRatio || 0;
        if (observed.isMerged || wr > 0.85) {
            // Merged blob: compare total holes
            return (holes[0] === exp.total) ? 1.2 : 0;
        } else {
            // Partial capture (one digit only).
            // Could be tens or units digit. Try both, take best.
            var matchTens = (holes[0] === exp.perDigit[0]) ? 0.8 : 0;
            var matchUnits = (holes[0] === exp.perDigit[1]) ? 0.8 : 0;
            return Math.max(matchTens, matchUnits);
        }
    }

    // Case 4: 2 CCs, single-digit number -> fragment, weak match
    if (nCCs === 2 && expectedNum < 10) {
        return (holes[0] === exp.perDigit[0]) ? 0.5 : 0;
    }

    // Case 5: 3 CCs, 3-digit number (100+) -> per-digit comparison
    if (nCCs === 3 && expectedNum >= 100) {
        if (hasAnomaly) return 0.2;
        var s31 = (holes[0] === exp.perDigit[0]) ? 1.0 : 0;
        var s32 = (holes[1] === exp.perDigit[1]) ? 1.0 : 0;
        var s33 = (holes[2] === exp.perDigit[2]) ? 1.0 : 0;
        return (s31 + s32 + s33) * 2.0 / 3.0; // normalize to 0-2 range
    }

    // Case 6: 2 CCs, 3-digit number (partial: two of three digits captured)
    if (nCCs === 2 && expectedNum >= 100) {
        if (hasAnomaly) return 0.1;
        // Try matching first two or last two digits
        var m12 = ((holes[0] === exp.perDigit[0]) ? 1 : 0) + ((holes[1] === exp.perDigit[1]) ? 1 : 0);
        var m23 = ((holes[0] === exp.perDigit[1]) ? 1 : 0) + ((holes[1] === exp.perDigit[2]) ? 1 : 0);
        return Math.max(m12, m23) * 0.5; // weaker since partial
    }

    // Case 7: 1 CC, 3-digit number (fully merged)
    if (nCCs === 1 && expectedNum >= 100) {
        if (hasAnomaly) return 0.1;
        return (holes[0] === exp.total) ? 1.0 : 0;
    }

    // Case 8: other combinations -> no match
    return 0;
}

function alignColumnByHoles(holeData, rowYs, rowCount, isFirstCol, isBackPage, colIndex, format, log, label, frontRows) {
    var nRows = holeData.length;
    if (nRows < 3) return null;

    // === PHASE 1: Detect gaps from spacing ===
    var spacings = [];
    for (var si = 1; si < rowYs.length; si++) spacings.push(rowYs[si] - rowYs[si-1]);
    var sortedSp = spacings.slice().sort(function(a,b){return a-b;});
    var base60 = sortedSp.slice(0, Math.ceil(sortedSp.length * 0.6));
    var medSpacing = base60[Math.floor(base60.length / 2)];

    // Build slot array
    var slots = [];
    slots.push({filled: true, holeData: holeData[0], obsIdx: 0, y: rowYs[0]});
    for (var gi = 1; gi < nRows; gi++) {
        var gap = rowYs[gi] - rowYs[gi-1];
        var numSlots = Math.round(gap / medSpacing);
        if (numSlots < 1) numSlots = 1;
        for (var mi = 1; mi < numSlots; mi++) {
            slots.push({filled: false, holeData: null, obsIdx: -1, y: rowYs[gi-1] + mi * medSpacing});
        }
        slots.push({filled: true, holeData: holeData[gi], obsIdx: gi, y: rowYs[gi]});
    }

    var gapCount = slots.filter(function(s){return !s.filled;}).length;
    log('    '+label+': spacing: '+nRows+' groups, '+gapCount+' gap(s), '+slots.length+' slots (base='+Math.round(medSpacing)+'px)','dim');
    if (gapCount > 0) {
        var gapPos = [];
        for (var gpi = 0; gpi < slots.length; gpi++) {
            if (!slots[gpi].filled) gapPos.push('slot'+gpi);
        }
        log('    '+label+': gaps at: '+gapPos.join(', '),'dim');
    }

    // === PHASE 2: Sliding window alignment ===
    // Start number is FIXED by column position. The only variable is the OFFSET:
    // where does number `startNum` sit within the slot array?
    //
    // offset < 0: head truncated (first |offset| numbers missing from image)
    // offset = 0: slot 0 = startNum (no headers)
    // offset > 0: slots 0..(offset-1) are headers, slot offset = startNum
    // offset > S-R: tail truncated (last numbers = END)
    //
    // Total iterations = maxTruncHead + excess + maxTruncTail + 1

    var frontCols = (format === '3col') ? 3 : 2;
    var frontRowCount = frontRows || rowCount; // fallback to rowCount if not specified
    var startNum = isBackPage
        ? (frontCols * frontRowCount + colIndex * rowCount + 1)
        : (colIndex * rowCount + 1);

    var S = slots.length;
    var R = rowCount;
    var excess = S - R; // positive = extra slots (headers/footers), negative = truncated
    var shortfall = Math.max(0, R - S); // how many more slots we need than we have
    var maxTruncHead = Math.max(3, shortfall + 1); // at least 3, or enough to cover missing rows + 1
    var maxTruncTail = Math.max(3, shortfall + 1);
    var minOffset = -maxTruncHead;
    var maxOffset = Math.max(excess, 0) + maxTruncTail;

    var bestResult = null;
    var bestAbsScore = -1;
    var allTrials = [];

    log('    '+label+': sliding window: '+S+' slots, '+R+' needed, startNum='+startNum
        +', offsets '+minOffset+'..'+maxOffset+' ('+(maxOffset-minOffset+1)+' iterations)','dim');

    for (var offset = minOffset; offset <= maxOffset; offset++) {
        // Build slot assignment for this offset
        var slotAssignment = [];
        var score = 0;
        var maxPossible = 0;

        for (var si2 = 0; si2 < S; si2++) {
            var numForSlot = startNum + (si2 - offset); // which number this slot maps to
            if (si2 < offset) {
                // Before data starts → header/non-data slot
                slotAssignment.push({num: null, type: 'header'});
            } else if (numForSlot > startNum + R - 1) {
                // Past the end of expected numbers → footer/non-data slot
                slotAssignment.push({num: null, type: 'footer'});
            } else if (numForSlot < startNum) {
                // Shouldn't happen with correct offset logic, but safety
                slotAssignment.push({num: null, type: 'header'});
            } else {
                // Data slot
                slotAssignment.push({num: numForSlot, type: slots[si2].filled ? 'filled' : 'gap'});

                // Score filled data slots
                if (slots[si2].filled && slots[si2].holeData) {
                    maxPossible += 2;
                    score += scoreHoleMatch(slots[si2].holeData, numForSlot);
                }
            }
        }

        // How many of the R numbers are covered by slots?
        var coveredCount = 0;
        for (var si3 = 0; si3 < slotAssignment.length; si3++) {
            if (slotAssignment[si3].num !== null) coveredCount++;
        }
        var headTrunc = Math.max(0, -offset); // numbers missing from top
        var tailTrunc = Math.max(0, (startNum + R - 1) - (startNum + S - 1 - offset)); // numbers missing from bottom
        if (tailTrunc < 0) tailTrunc = 0;
        tailTrunc = R - coveredCount - headTrunc;
        if (tailTrunc < 0) tailTrunc = 0;

        var pct = maxPossible > 0 ? (score / maxPossible * 100) : 0;

        // Label for logging
        var headStr = headTrunc > 0 ? ' headTrunc=' + headTrunc : '';
        var tailStr = tailTrunc > 0 ? ' tailTrunc=' + tailTrunc : '';
        var hdrStr = offset > 0 ? ' hdr=' + offset : '';
        var trialLabel = 'offset=' + offset + hdrStr + headStr + tailStr
            + ' → ' + Math.round(score*10)/10 + '/' + maxPossible
            + ' (' + Math.round(pct) + '%)';

        allTrials.push({
            label: trialLabel, pct: pct, score: score, maxPossible: maxPossible,
            offset: offset, headTrunc: headTrunc, tailTrunc: tailTrunc,
            slotAssignment: slotAssignment
        });

        if (score > bestAbsScore || (score === bestAbsScore && Math.abs(offset) < Math.abs(bestResult.offset))) {
            bestAbsScore = score;
            bestResult = {
                startNum: startNum, score: score, pct: pct,
                maxScore: maxPossible, offset: offset,
                headTrunc: headTrunc, tailTrunc: tailTrunc,
                dataSlotStart: Math.max(0, offset),
                slots: slots, slotAssignment: slotAssignment,
                hasHeaderRow: offset > 0,
                headSkip: headTrunc,
                totalSlots: coveredCount
            };
        }
    }

    // Log ALL trials (there are only ~11)
    if (log) {
        log('    '+label+': all alignment trials:','dim');
        for (var ti3 = 0; ti3 < allTrials.length; ti3++) {
            var marker = (allTrials[ti3].offset === bestResult.offset) ? ' ★' : '';
            log('      '+allTrials[ti3].label+marker,'dim');
        }
    }

    // === PHASE 3: Report best alignment ===
    if (bestResult && log) {
        log('    '+label+': ALIGN: offset='+bestResult.offset
            +' ('+startNum+'...'+(startNum+R-1)+')'
            +' score='+Math.round(bestResult.score*10)/10+'/'+bestResult.maxScore
            +' ('+Math.round(bestResult.pct)+'%)'
            +(bestResult.headTrunc > 0 ? ' [head trunc '+bestResult.headTrunc+']' : '')
            +(bestResult.tailTrunc > 0 ? ' [tail trunc '+bestResult.tailTrunc+']' : '')
            +(bestResult.offset > 0 ? ' ['+bestResult.offset+' hdr slot(s)]' : '')
            ,'good');

        // Detailed slot-by-slot output
        var alignLines = [];

        // Head-truncated numbers (not in slot array)
        for (var ht = 0; ht < bestResult.headTrunc; ht++) {
            alignLines.push((startNum + ht) + ':TRUNC');
        }

        for (var ai = 0; ai < bestResult.slotAssignment.length; ai++) {
            var sa = bestResult.slotAssignment[ai];
            var slot = bestResult.slots[ai];
            if (sa.type === 'header' || sa.type === 'footer') {
                var hdrLabel = sa.type === 'header' ? 'HDR' : 'FTR';
                alignLines.push(hdrLabel + '(h=' + (slot.filled ? slot.holeData.signature : '?') + ')');
            } else if (!slot.filled) {
                alignLines.push(sa.num + ':GAP');
            } else {
                var ms = scoreHoleMatch(slot.holeData, sa.num);
                var msR = Math.round(ms * 10) / 10;
                var mark = ms >= 1.8 ? '\u2713\u2713' : (ms >= 0.8 ? '\u2713' : (ms >= 0.3 ? '~' : '\u2717'));
                alignLines.push(sa.num + mark + '(' + msR + ')');
            }
        }

        // Tail-truncated numbers
        var lastMappedNum = startNum + R - 1 - bestResult.tailTrunc;
        for (var tt = lastMappedNum + 1; tt <= startNum + R - 1; tt++) {
            alignLines.push(tt + ':END');
        }

        for (var ali = 0; ali < alignLines.length; ali += 8) {
            var aChunk = alignLines.slice(ali, Math.min(ali + 8, alignLines.length));
            log('      ' + aChunk.join('  '),'dim');
        }
    }

    return bestResult;
}

/**
 * Classify row-groups by their width signature to identify data rows vs headers.
 *
 * Printed move numbers have a distinctive width pattern:
 *   "1"       → very narrow  (w/h < 0.35)
 *   "2"-"9"   → single-digit (w/h ≈ 0.4-0.75)
 *   "10"-"30" → double-digit (w/h ≈ 0.7-1.6), noticeably wider than singles
 *   "WHITE"   → header text  (w/h > 2.0 or totalW > 3× medDigitH)
 *
 * The single→double transition at row 9→10 is a powerful anchor:
 * if present, it tells us EXACTLY which row is "9" and which is "10".
 *
 * @param {Array} rowStats - array of {cy, medH, totalW, count, group} per row-group
 * @param {number} rowCount - expected number of data rows (20, 25, or 30)
 * @param {Function} log - logging function
 * @param {string} label - column label for logging
 * @returns {Object} {dataRows: indices[], headerRows: indices[], footerRows: indices[],
 *                     transitionIdx: number|null, startsAt1: boolean}
 */

// =============================================================================
// WIDTH-BASED ROW CLASSIFICATION (header/footer detection)
// =============================================================================

function classifyClusterRows(rowStats, rowCount, log, label, colIndex, isBackPage) {
    if (rowStats.length < 5) return {dataRows: rowStats.map(function(_,i){return i;}), headerRows: [], footerRows: [], transitionIdx: null, startsAt1: false};

    // Step 1: Compute median component height from the core (middle 60%)
    var allH = [];
    for (var i = 0; i < rowStats.length; i++) allH.push(rowStats[i].medH);
    allH.sort(function(a,b){return a-b;});
    var coreH = allH.slice(Math.floor(allH.length*0.2), Math.ceil(allH.length*0.8));
    var medDigitH = coreH[Math.floor(coreH.length/2)];

    // Step 2: Classify each row-group by width-to-height ratio
    // Only col1 on front page has single digits (1-9).
    // Col2+ on front page AND all columns on back page are all double-digit.
    var isFirstCol = (colIndex === 0 && !isBackPage);

    var classifications = rowStats.map(function(r, ri) {
        var wRatio = r.totalW / Math.max(1, medDigitH);
        var hRatio = r.medH / Math.max(1, medDigitH);
        var type;

        // Header detection: clearly non-digit sized components
        // Must also have enough CCs to be text (numbers have 1-3 CCs at most)
        if ((wRatio > 2.5 || r.totalW > medDigitH * 3.5) && r.count >= 4) {
            type = 'header'; // "WHITE", "BLACK", "#", "Result:"
        } else if (hRatio > 2.0 || hRatio < 0.4) {
            type = 'header'; // wrong font size entirely
        } else if (!isFirstCol) {
            // Col 2+: everything digit-sized is a double-digit number
            type = 'double';
        } else if (wRatio < 0.35) {
            type = 'digit-1'; // the digit "1" is uniquely narrow
        } else if (wRatio < 0.75) {
            type = 'single'; // single digit 2-9
        } else {
            type = 'double'; // double digit 10+
        }
        return {index: ri, type: type, wRatio: Math.round(wRatio*100)/100, hRatio: Math.round(hRatio*100)/100};
    });

    // Step 3: Find the longest contiguous run of digit-type rows
    var isDigit = classifications.map(function(c){return c.type !== 'header';});
    var bestRunStart = 0, bestRunLen = 0, runStart = 0;
    for (var i = 0; i < isDigit.length; i++) {
        if (isDigit[i]) {
            if (i === 0 || !isDigit[i-1]) runStart = i;
            var runLen = i - runStart + 1;
            if (runLen > bestRunLen) { bestRunLen = runLen; bestRunStart = runStart; }
        }
    }

    // Step 4: Find the single→double transition (ONLY for first column)
    var transitionIdx = null;
    var startsAt1 = false;
    if (isFirstCol) {
        for (var ti = bestRunStart; ti < bestRunStart + bestRunLen - 1; ti++) {
            var curr = classifications[ti];
            var next = classifications[ti+1];
            if ((curr.type === 'single' || curr.type === 'digit-1') && next.type === 'double') {
                // Validate: there should be multiple single-digit rows before this
                // (at least 5 of rows 1-9 detected). A lone "single" is just noise.
                var singlesBefore = 0;
                for (var si = bestRunStart; si <= ti; si++) {
                    if (classifications[si].type === 'single' || classifications[si].type === 'digit-1') singlesBefore++;
                }
                if (singlesBefore >= 5) {
                    transitionIdx = ti;
                    startsAt1 = true;
                }
                break; // Only check the first transition
            }
        }
    }

    // Step 5: Determine data rows from the data run
    var dataStart, dataEnd;
    if (transitionIdx !== null) {
        // transition is at row "9", row "1" is 8 before it
        dataStart = Math.max(bestRunStart, transitionIdx - 8);
        dataEnd = Math.min(bestRunStart + bestRunLen, dataStart + rowCount);
    } else {
        // No transition: use the full data run, capped at rowCount
        // Prefer bottom-aligned (bottom rows are most reliable)
        dataEnd = Math.min(bestRunStart + bestRunLen, rowStats.length);
        dataStart = Math.max(bestRunStart, dataEnd - rowCount);
    }

    var dataRows = [];
    for (var dri = dataStart; dri < dataEnd; dri++) dataRows.push(dri);

    // Only flag headers/footers OUTSIDE the data range
    // Key insight: any row ABOVE a block of H rows is also header material
    // (e.g., "#" is classified as D but sits above "WHITE"/"BLACK" H rows)
    var headerRows = [];
    if (dataStart > 0) {
        // Find the lowest H row before dataStart
        var lastHBeforeData = -1;
        for (var hri = dataStart - 1; hri >= 0; hri--) {
            if (classifications[hri].type === 'header') { lastHBeforeData = hri; }
        }
        if (lastHBeforeData >= 0) {
            // Everything from 0 to lastH (inclusive) is header zone
            // (catches "#" above "WHITE"/"BLACK" even if "#" looks like a digit)
            for (var hri2 = 0; hri2 <= lastHBeforeData; hri2++) {
                headerRows.push(hri2);
            }
            // Also flag any remaining rows between lastH+1 and dataStart
            // that are classified as header
            for (var hri3 = lastHBeforeData + 1; hri3 < dataStart; hri3++) {
                if (classifications[hri3].type === 'header') headerRows.push(hri3);
            }
        } else {
            // No H rows before data — only flag actual H-classified rows
            for (var hri4 = 0; hri4 < dataStart; hri4++) {
                if (classifications[hri4].type === 'header') headerRows.push(hri4);
            }
        }
    }

    var footerRows = [];
    if (dataEnd < rowStats.length) {
        // Find the highest H row after dataEnd
        var firstHAfterData = -1;
        for (var fri = dataEnd; fri < rowStats.length; fri++) {
            if (classifications[fri].type === 'header') { firstHAfterData = fri; break; }
        }
        if (firstHAfterData >= 0) {
            // Everything from firstH to end is footer zone
            for (var fri2 = firstHAfterData; fri2 < rowStats.length; fri2++) {
                footerRows.push(fri2);
            }
            // Also flag H rows between dataEnd and firstH
            for (var fri3 = dataEnd; fri3 < firstHAfterData; fri3++) {
                if (classifications[fri3].type === 'header') footerRows.push(fri3);
            }
        } else {
            for (var fri4 = dataEnd; fri4 < rowStats.length; fri4++) {
                if (classifications[fri4].type === 'header') footerRows.push(fri4);
            }
        }
    }

    // Logging
    if (log) {
        var typeStr = classifications.map(function(c) {
            if (c.type === 'header') return 'H';
            if (c.type === 'digit-1') return '1';
            if (c.type === 'single') return 's';
            if (c.type === 'double') return 'D';
            return '?';
        }).join('');
        log('    '+label+': width classification: ['+typeStr+'] (medH='+Math.round(medDigitH)
            +(isFirstCol ? ', col1-front: transition search ON' : ', all-double mode'+(isBackPage?' (back page)':''))
            +')','dim');
        log('    '+label+': data run ['+dataStart+'..'+dataEnd+'] = '+dataRows.length+' rows'
            +(transitionIdx !== null ? ', 9→10 transition at idx '+transitionIdx : '')
            +(headerRows.length > 0 ? ', '+headerRows.length+' header(s)' : '')
            +(footerRows.length > 0 ? ', '+footerRows.length+' footer(s)' : ''),'dim');

        if (headerRows.length > 0 || transitionIdx !== null) {
            var logRows = [];
            if (headerRows.length > 0) logRows.push('headers: '+headerRows.map(function(i){return 'r'+i+'(w='+classifications[i].wRatio+')';}).join(' '));
            if (transitionIdx !== null) logRows.push('transition: r'+transitionIdx+'('+classifications[transitionIdx].type+')→r'+(transitionIdx+1)+'('+classifications[transitionIdx+1].type+')');
            log('    '+label+': '+logRows.join(' | '),'dim');
        }
    }

    return {
        dataRows: dataRows,
        headerRows: headerRows,
        footerRows: footerRows,
        transitionIdx: transitionIdx,
        startsAt1: startsAt1,
        classifications: classifications,
        medDigitH: medDigitH
    };
}

// =============================================================================
// CLUSTER CLEANING
// =============================================================================

function cleanCluster(cluster, rowCount, colIndex, log) {
    var label = 'Col'+(colIndex+1);
    if (cluster.length < 5) return {cleaned: cluster, removed: [], stats: {reason: 'too-small'}};

    // Step 1: Group into rows (same as buildRowsFromCluster)
    var sorted = cluster.slice().sort(function(a,b){return a.cy-b.cy;});
    var avgH = sorted.reduce(function(s,c){return s+c.h;},0)/sorted.length;
    var yTol = avgH * 0.6;
    var groups = [[sorted[0]]];
    for (var i = 1; i < sorted.length; i++) {
        var last = groups[groups.length-1];
        if (sorted[i].cy - last[last.length-1].cy <= yTol) last.push(sorted[i]);
        else groups.push([sorted[i]]);
    }

    // Row-level stats
    var rowStats = groups.map(function(g, ri) {
        var cy = g.reduce(function(s,c){return s+c.cy;},0)/g.length;
        var medH = g.map(function(c){return c.h;}).sort(function(a,b){return a-b;})[Math.floor(g.length/2)];
        var totalW = Math.max.apply(null,g.map(function(c){return c.x+c.w;})) - Math.min.apply(null,g.map(function(c){return c.x;}));
        return {index: ri, cy: cy, medH: medH, totalW: totalW, count: g.length, group: g};
    });

    if (rowStats.length < 5) return {cleaned: cluster, removed: [], stats: {reason: 'few-rows('+rowStats.length+')'}};

    // Step 2: Compute median component height from the core (middle 60%)
    var allHeights = [];
    for (var hi = 0; hi < sorted.length; hi++) allHeights.push(sorted[hi].h);
    allHeights.sort(function(a,b){return a-b;});
    var coreStart = Math.floor(allHeights.length * 0.2);
    var coreEnd = Math.ceil(allHeights.length * 0.8);
    var coreHeights = allHeights.slice(coreStart, coreEnd);
    var medCompH = coreHeights[Math.floor(coreHeights.length/2)];

    // Step 3: Compute median spacing from the core rows
    var spacings = [];
    for (var si = 1; si < rowStats.length; si++) {
        spacings.push(rowStats[si].cy - rowStats[si-1].cy);
    }
    var sortedSp = spacings.slice().sort(function(a,b){return a-b;});
    var medSpacing = sortedSp[Math.floor(sortedSp.length/2)];

    // Step 4: Score each row for "move-number-ness"
    var removed = [];
    var kept = [];

    for (var ri = 0; ri < rowStats.length; ri++) {
        var r = rowStats[ri];
        var problems = [];

        // Height check: component height should be within 0.5x to 2.0x of median
        if (r.medH > medCompH * 2.2) problems.push('tall('+Math.round(r.medH)+'>'+Math.round(medCompH*2.2)+')');
        if (r.medH < medCompH * 0.4) problems.push('short('+Math.round(r.medH)+'<'+Math.round(medCompH*0.4)+')');

        // Width check: "White"/"Black" labels are very wide (>3x median component height)
        if (r.totalW > medCompH * 4) problems.push('wide('+Math.round(r.totalW)+'>'+Math.round(medCompH*4)+')');

        // Spacing check (only for top and bottom rows)
        if (ri === 0 && spacings.length > 0) {
            var topGap = spacings[0];
            if (topGap > medSpacing * 1.8) problems.push('topGap('+Math.round(topGap)+'>'+Math.round(medSpacing*1.8)+')');
            if (topGap < medSpacing * 0.4) problems.push('topGapSmall('+Math.round(topGap)+'<'+Math.round(medSpacing*0.4)+')');
        }
        if (ri === rowStats.length - 1 && spacings.length > 0) {
            var botGap = spacings[spacings.length-1];
            if (botGap > medSpacing * 1.8) problems.push('botGap('+Math.round(botGap)+'>'+Math.round(medSpacing*1.8)+')');
            if (botGap < medSpacing * 0.4) problems.push('botGapSmall('+Math.round(botGap)+'<'+Math.round(medSpacing*0.4)+')');
        }

        if (problems.length > 0 && (ri < 3 || ri > rowStats.length - 3)) {
            removed.push({row: r, reasons: problems});
            if (log) log('    '+label+': reject row '+ri+' (y='+Math.round(r.cy)+'): '+problems.join(', '),'warn');
        } else {
            kept.push(r);
        }
    }

    // Step 5: Width signature validation (informational)
    if (kept.length >= 12 && log) {
        var firstNine = kept.slice(0, Math.min(9, kept.length));
        var afterNine = kept.slice(9);
        if (afterNine.length >= 3) {
            var avgWFirst = firstNine.reduce(function(s,r){return s+r.totalW;},0)/firstNine.length;
            var avgWAfter = afterNine.reduce(function(s,r){return s+r.totalW;},0)/afterNine.length;
            var widthRatio = avgWAfter / Math.max(1, avgWFirst);
            if (widthRatio > 1.3) {
                log('    '+label+': width transition at row 9 (single->double digit): '
                    +Math.round(avgWFirst)+'->'+Math.round(avgWAfter)+' (ratio='+widthRatio.toFixed(2)+')'
                    +' -> likely first column','dim');
            } else {
                log('    '+label+': uniform width (ratio='+widthRatio.toFixed(2)+') -> likely column 2+','dim');
            }
        }
    }

    // Step 6: Spacing regularity check on kept rows
    if (kept.length >= 5 && log) {
        var keptSp = [];
        for (var ki = 1; ki < kept.length; ki++) keptSp.push(kept[ki].cy - kept[ki-1].cy);
        var keptMed = keptSp.slice().sort(function(a,b){return a-b;})[Math.floor(keptSp.length/2)];
        var regular = 0, gapMultiples = [];
        for (var gi = 0; gi < keptSp.length; gi++) {
            var ratio = keptSp[gi] / keptMed;
            var nearestInt = Math.round(ratio);
            if (nearestInt >= 1 && nearestInt <= 3 && Math.abs(ratio - nearestInt) < 0.3) {
                regular++;
                gapMultiples.push(nearestInt);
            } else {
                gapMultiples.push('?');
            }
        }
        log('    '+label+': spacing regularity: '+regular+'/'+keptSp.length
            +' gaps are clean multiples of base='+Math.round(keptMed)+'px'
            +' ['+gapMultiples.join(',')+']','dim');
    }

    // Rebuild cleaned cluster from kept rows
    var cleanedComponents = [];
    for (var ci = 0; ci < kept.length; ci++) {
        for (var gi2 = 0; gi2 < kept[ci].group.length; gi2++) {
            cleanedComponents.push(kept[ci].group[gi2]);
        }
    }

    var removedComponents = [];
    for (var rci = 0; rci < removed.length; rci++) {
        for (var rgi = 0; rgi < removed[rci].row.group.length; rgi++) {
            removedComponents.push(removed[rci].row.group[rgi]);
        }
    }

    if (removed.length > 0 && log) {
        log('    '+label+': cleaned '+cluster.length+'->'+cleanedComponents.length
            +' components (removed '+removedComponents.length+' in '+removed.length+' rows)','good');
    }

    return {
        cleaned: cleanedComponents,
        removed: removedComponents,
        stats: {
            medCompH: medCompH,
            medSpacing: medSpacing,
            rowsBefore: rowStats.length,
            rowsAfter: kept.length,
            removedCount: removed.length
        }
    };
}

// =============================================================================
// WARP: 4 anchor corners → perspective transform
// =============================================================================

// =============================================================================
// ANCHOR GRID GEOMETRY (fillAnchors, getYBoundaries, interpolateY)
// =============================================================================

function fillAnchors(anchors, rowCount, log, label) {
    if (anchors.length < 1) return anchors;

    // Need at least 2 anchors for spacing computation
    var sps = [];
    for (var i = 1; i < anchors.length; i++) sps.push(anchors[i].y - anchors[i-1].y);
    if (sps.length === 0) {
        if (log) log('    '+label+': only '+anchors.length+' anchor(s), cannot fill','warn');
        return anchors;
    }

    // === Step 1: Compute ROBUST median from core spacings (middle 60%) ===
    // This prevents outlier gaps (from contamination) from skewing the median itself
    var sortedSps = sps.slice().sort(function(a,b){return a-b;});
    var medSp;
    if (sortedSps.length >= 5) {
        var coreStart = Math.floor(sortedSps.length * 0.2);
        var coreEnd = Math.ceil(sortedSps.length * 0.8);
        var core = sortedSps.slice(coreStart, coreEnd);
        medSp = core[Math.floor(core.length/2)];
    } else {
        medSp = sortedSps[Math.floor(sortedSps.length/2)];
    }

    // === Step 2: Remove squeezed anchors — ONLY if more than rowCount ===
    // If we have ≤ rowCount CCs, trust them all (perspective compression is normal).
    // Only remove contaminants when there's an excess (header/footer junk).
    var cleaned = anchors.slice();
    var removedCount = 0;
    if (anchors.length > rowCount) {
    var changed = true;
    while (changed && cleaned.length >= 4) {
        changed = false;
        for (var ci = 0; ci < cleaned.length - 1; ci++) {
            var gap = cleaned[ci+1].y - cleaned[ci].y;
            if (gap < medSp * 0.4) {
                // Squeezed pair found — decide which one to remove
                // The one that disrupts spacing with ITS other neighbor more is the contaminant
                var removeIdx;
                if (ci === 0) {
                    // First anchor — remove it (likely header)
                    removeIdx = 0;
                } else if (ci + 1 === cleaned.length - 1) {
                    // Last anchor — remove it (likely footer)
                    removeIdx = ci + 1;
                } else {
                    // Interior: check which removal gives better spacing
                    var gapBefore = (ci > 0) ? cleaned[ci].y - cleaned[ci-1].y : Infinity;
                    var gapAfter = (ci + 2 < cleaned.length) ? cleaned[ci+2].y - cleaned[ci+1].y : Infinity;
                    // Remove the one whose OTHER gap is worse (further from median)
                    var errA = Math.abs(gapBefore - medSp);
                    var errB = Math.abs(gapAfter - medSp);
                    removeIdx = (errA >= errB) ? ci : ci + 1;
                }
                if (log) log('    '+label+': squeezed gap at idx '+ci+' (y='+Math.round(cleaned[ci].y)
                    +'..'+Math.round(cleaned[ci+1].y)+', gap='+Math.round(gap)
                    +' < '+Math.round(medSp*0.4)+') — removing idx '+removeIdx,'warn');
                cleaned.splice(removeIdx, 1);
                removedCount++;
                changed = true;
                break; // restart scan after removal
            }
        }
    }
    } // end if (anchors.length > rowCount)

    // Recompute median from cleaned spacings
    if (removedCount > 0 && cleaned.length >= 2) {
        sps = [];
        for (var si = 1; si < cleaned.length; si++) sps.push(cleaned[si].y - cleaned[si-1].y);
        sortedSps = sps.slice().sort(function(a,b){return a-b;});
        if (sortedSps.length >= 5) {
            var cs2 = Math.floor(sortedSps.length * 0.2);
            var ce2 = Math.ceil(sortedSps.length * 0.8);
            medSp = sortedSps.slice(cs2, ce2)[Math.floor((ce2-cs2)/2)];
        } else {
            medSp = sortedSps[Math.floor(sortedSps.length/2)];
        }
    }

    if (cleaned.length === rowCount && removedCount === 0) return cleaned;

    // === Step 3: Compute median x, left, right for synthetic anchors ===
    var medX = cleaned.map(function(a){return a.x;}).sort(function(a,b){return a-b;})[Math.floor(cleaned.length/2)];
    var medLeft = cleaned.map(function(a){return a.left;}).sort(function(a,b){return a-b;})[Math.floor(cleaned.length/2)];
    var medRight = cleaned.map(function(a){return a.right;}).sort(function(a,b){return a-b;})[Math.floor(cleaned.length/2)];

    // === Step 4: Interpolate interior gaps > 1.5× median ===
    var filled = [cleaned[0]];
    for (var j = 1; j < cleaned.length; j++) {
        var gap = cleaned[j].y - filled[filled.length-1].y;
        if (gap > medSp * 1.5) {
            var numMissing = Math.round(gap / medSp) - 1;
            var stepY = gap / (numMissing + 1);
            for (var m = 1; m <= numMissing; m++) {
                var fy = filled[filled.length-1].y + stepY;
                filled.push({y: fy, x: medX, left: medLeft, right: medRight, filled: true});
            }
        }
        filled.push(cleaned[j]);
    }

    // === Step 5: Extrapolate top (prepend) ===
    while (filled.length < rowCount && filled[0].y - medSp > -medSp*0.3) {
        var newY = filled[0].y - medSp;
        filled.unshift({y: newY, x: medX, left: medLeft, right: medRight, filled: true});
    }
    // === Step 6: Extrapolate bottom (append) ===
    while (filled.length < rowCount) {
        var newYb = filled[filled.length-1].y + medSp;
        filled.push({y: newYb, x: medX, left: medLeft, right: medRight, filled: true});
    }

    if (filled.length > rowCount) filled = filled.slice(filled.length - rowCount);

    // === Step 7: Final validation — all gaps should be roughly equal ===
    if (log && filled.length >= 2) {
        var finalSps = [];
        for (var fi = 1; fi < filled.length; fi++) finalSps.push(filled[fi].y - filled[fi-1].y);
        var finalMed = finalSps.slice().sort(function(a,b){return a-b;})[Math.floor(finalSps.length/2)];
        var badGaps = 0;
        for (var fj = 0; fj < finalSps.length; fj++) {
            if (finalSps[fj] < finalMed * 0.5 || finalSps[fj] > finalMed * 1.5) badGaps++;
        }
        if (badGaps > 0) {
            log('    '+label+': WARNING '+badGaps+' non-uniform gaps remain after fill (med='+Math.round(finalMed)+')','warn');
        }
    }

    if (log) {
        var filledCount = filled.filter(function(a){return a.filled;}).length;
        log('    '+label+': '+anchors.length+' → '+filled.length + (filledCount>0 ? ' ('+filledCount+' interpolated)' : '')
            + (removedCount>0 ? ' [removed '+removedCount+' squeezed]' : ''),'dim');
    }
    return filled;
}

/**
 * Compute row boundaries (midpoints between centroids) for a group.
 * Returns rowCount+1 boundary y-values.
 */

function getYBoundaries(anchors, wh) {
    var bounds = [];
    if (anchors.length < 1) return bounds;
    var topGap = (anchors.length > 1) ? (anchors[1].y - anchors[0].y) : 50;
    bounds.push(Math.max(0, anchors[0].y - topGap / 2));
    for (var i = 0; i < anchors.length - 1; i++) {
        bounds.push((anchors[i].y + anchors[i+1].y) / 2);
    }
    var botGap = (anchors.length > 1) ? (anchors[anchors.length-1].y - anchors[anchors.length-2].y) : topGap;
    bounds.push(Math.min(wh - 1, anchors[anchors.length-1].y + botGap / 2));
    return bounds;
}

/**
 * Interpolate y at a given x-position between two anchor groups.
 * groupXs: array of median x per group
 * groupYBounds: array of boundary arrays per group
 * Returns y for boundary index `bi` at position `x`.
 */

function interpolateY(x, bi, groupXs, groupYBounds) {
    // Find the two groups that bracket x
    var ng = groupXs.length;
    if (ng === 1) return groupYBounds[0][bi];

    // Clamp to range
    if (x <= groupXs[0]) return groupYBounds[0][bi];
    if (x >= groupXs[ng-1]) return groupYBounds[ng-1][bi];

    // Find bracketing groups
    for (var g = 0; g < ng - 1; g++) {
        if (x >= groupXs[g] && x <= groupXs[g+1]) {
            var t = (x - groupXs[g]) / (groupXs[g+1] - groupXs[g]);
            return groupYBounds[g][bi] * (1-t) + groupYBounds[g+1][bi] * t;
        }
    }
    return groupYBounds[ng-1][bi]; // fallback
}


// =============================================================================
// DIRECT CELL EXTRACTION (per-cell mini-warp, no global perspective)
// =============================================================================

function extractCellsDirect(srcMat, colR, rowCount, format, log) {
    var ww = srcMat.cols, wh = srcMat.rows;
    var numGroups = colR.length;
    var cells = [];
    var numPadRight = 6;

    // Compute dynamic right padding based on median number CC width
    // This ensures move cells don't extend too far into the gap before the next number column
    var allWidths = [];
    for (var aw = 0; aw < numGroups; aw++) {
        for (var ai = 0; ai < colR[aw].length; ai++) {
            var w = colR[aw][ai].right - colR[aw][ai].left;
            if (w > 0) allWidths.push(w);
        }
    }
    allWidths.sort(function(a,b){return a-b;});
    var medNumW = allWidths.length > 0 ? allWidths[Math.floor(allWidths.length/2)] : 20;
    var padX = Math.max(5, Math.round(medNumW * 1.1));

    log('  Direct extraction from original: '+numGroups+' groups, '+rowCount+' rows','dim');
    log('  Median number CC width: '+Math.round(medNumW)+'px → right padding: '+padX+'px','dim');


    // =====================================================================
    // Step 1: EQUIDISTANT GRID — trust uniform CCs, grid-fit non-uniform
    // =====================================================================
    // Two paths:
    //   FAST: count == rowCount AND all spacings uniform → keep as-is
    //   GRID: Otherwise → find best equidistant grid, snap real CCs, fill rest

    var filled = [];
    for (var fg = 0; fg < numGroups; fg++) {
        var raw = colR[fg].slice().sort(function(a,b){return a.y - b.y;});

        if (raw.length < 2) {
            log('    Group'+(fg+1)+': only '+raw.length+' CCs','warn');
            filled.push(raw);
            continue;
        }

        // Compute robust median spacing (core 30-70%)
        var sps = [];
        for (var si = 1; si < raw.length; si++) sps.push(raw[si].y - raw[si-1].y);
        sps.sort(function(a,b){return a-b;});
        var colMedSp;
        if (sps.length >= 5) {
            var cs = Math.floor(sps.length * 0.3), ce = Math.ceil(sps.length * 0.7);
            colMedSp = sps.slice(cs, ce)[Math.floor((ce-cs)/2)];
        } else {
            colMedSp = sps[Math.floor(sps.length/2)];
        }

        // Check uniformity: all gaps within 0.5x-1.6x median?
        var uniform = true;
        for (var ui = 1; ui < raw.length; ui++) {
            var g = raw[ui].y - raw[ui-1].y;
            if (g < colMedSp * 0.5 || g > colMedSp * 1.6) { uniform = false; break; }
        }

        // FAST PATH: perfect CCs — all present and evenly spaced
        if (raw.length === rowCount && uniform) {
            log('    Group'+(fg+1)+': '+raw.length+' CCs, uniform (med='+Math.round(colMedSp)+') — keeping all','good');
            filled.push(raw);
            continue;
        }

        // GRID PATH: find best equidistant grid that matches real CCs
        log('    Group'+(fg+1)+': '+raw.length+' CCs, med='+Math.round(colMedSp)+'px'
            + (uniform ? '' : ', NON-UNIFORM') + ' — grid fit','dim');

        var snapTol = colMedSp * 0.3;
        var bestOrigin = null, bestMatches = -1;

        for (var ai = 0; ai < raw.length; ai++) {
            for (var ri = 0; ri < rowCount; ri++) {
                var row0Y = raw[ai].y - ri * colMedSp;
                if (row0Y < -colMedSp * 0.5) continue;
                if (row0Y > wh * 0.3) continue;

                var matches = 0, used = [];
                for (var gi = 0; gi < rowCount; gi++) {
                    var idealY = row0Y + gi * colMedSp;
                    var bd = Infinity, bc = -1;
                    for (var ci = 0; ci < raw.length; ci++) {
                        if (used.indexOf(ci) >= 0) continue;
                        var d = Math.abs(raw[ci].y - idealY);
                        if (d < bd) { bd = d; bc = ci; }
                    }
                    if (bc >= 0 && bd <= snapTol) { matches++; used.push(bc); }
                }
                if (matches > bestMatches) {
                    bestMatches = matches;
                    bestOrigin = {anchorIdx: ai, rowIdx: ri, row0Y: row0Y};
                }
            }
        }

        log('    Group'+(fg+1)+': grid best: anchor '+bestOrigin.anchorIdx
            +' as row '+(bestOrigin.rowIdx+1)+', '+bestMatches+'/'+rowCount+' matched','dim');

        // Build grid: snap real CCs, interpolate rest
        var grid = [];
        var usedCCs = [];
        for (var gi = 0; gi < rowCount; gi++) {
            var idealY = bestOrigin.row0Y + gi * colMedSp;
            var bd = Infinity, bestCC = null, bestIdx = -1;
            for (var ci = 0; ci < raw.length; ci++) {
                if (usedCCs.indexOf(ci) >= 0) continue;
                var d = Math.abs(raw[ci].y - idealY);
                if (d < bd) { bd = d; bestCC = raw[ci]; bestIdx = ci; }
            }
            if (bestCC && bd <= snapTol) {
                grid.push(bestCC);
                usedCCs.push(bestIdx);
            } else {
                grid.push({y: idealY, x: 0, left: 0, right: 0, filled: true});
            }
        }

        // Interpolate x/left/right for filled slots from nearest real neighbors
        for (var ii = 0; ii < grid.length; ii++) {
            if (!grid[ii].filled) continue;
            var above = null, below = null;
            for (var ua = ii-1; ua >= 0; ua--) { if (!grid[ua].filled) { above = grid[ua]; break; } }
            for (var ub = ii+1; ub < grid.length; ub++) { if (!grid[ub].filled) { below = grid[ub]; break; } }
            if (above && below) {
                var t = (grid[ii].y - above.y) / (below.y - above.y);
                grid[ii].x = above.x + t*(below.x - above.x);
                grid[ii].left = above.left + t*(below.left - above.left);
                grid[ii].right = above.right + t*(below.right - above.right);
            } else if (above) { grid[ii].x = above.x; grid[ii].left = above.left; grid[ii].right = above.right; }
            else if (below) { grid[ii].x = below.x; grid[ii].left = below.left; grid[ii].right = below.right; }
        }

        var interpCount = grid.filter(function(a){return a.filled;}).length;
        log('    Group'+(fg+1)+': '+interpCount+' interpolated, '+(rowCount-interpCount)+' snapped','dim');
        filled.push(grid);
    }

    // =====================================================================
    // Step 1b: CROSS-COLUMN ALIGNMENT
    // =====================================================================
    // All columns cover the same physical rows. If column A has a real CC
    // at row N but column B has an interpolated one, adjust B's row N
    // to be consistent with A (accounting for inter-column slope).
    if (filled.length >= 2) {
        // First compute the typical y-offset between adjacent columns
        // from rows where BOTH have real CCs
        for (var pg = 0; pg < filled.length - 1; pg++) {
            var offsets = [];
            for (var pr = 0; pr < rowCount; pr++) {
                if (!filled[pg][pr].filled && !filled[pg+1][pr].filled) {
                    offsets.push(filled[pg+1][pr].y - filled[pg][pr].y);
                }
            }
            if (offsets.length < 3) continue;
            offsets.sort(function(a,b){return a-b;});
            var medOffset = offsets[Math.floor(offsets.length/2)];
            log('  Cross-align: Group'+(pg+1)+'→'+(pg+2)+' medOffset='+Math.round(medOffset)
                +'px (from '+offsets.length+' shared real rows)','dim');

            // Now fix interpolated rows using the other column's real CC + offset
            for (var cr = 0; cr < rowCount; cr++) {
                var a = filled[pg][cr], b = filled[pg+1][cr];
                if (a.filled && !b.filled) {
                    // Column pg has interpolated, pg+1 has real → fix pg
                    var betterY = b.y - medOffset;
                    if (Math.abs(betterY - a.y) > 3) { // only if meaningful difference
                        log('    Row '+(cr+1)+': align Group'+(pg+1)+' y='+Math.round(a.y)
                            +'→'+Math.round(betterY)+' (from Group'+(pg+2)+' real y='+Math.round(b.y)+')','dim');
                        filled[pg][cr] = {y: betterY, x: a.x, left: a.left, right: a.right, filled: true};
                    }
                } else if (!a.filled && b.filled) {
                    // Column pg has real, pg+1 has interpolated → fix pg+1
                    var betterY2 = a.y + medOffset;
                    if (Math.abs(betterY2 - b.y) > 3) {
                        log('    Row '+(cr+1)+': align Group'+(pg+2)+' y='+Math.round(b.y)
                            +'→'+Math.round(betterY2)+' (from Group'+(pg+1)+' real y='+Math.round(a.y)+')','dim');
                        filled[pg+1][cr] = {y: betterY2, x: b.x, left: b.left, right: b.right, filled: true};
                    }
                }
            }
        }
    }

    // Step 2: Compute y-boundaries per group (midpoints between centroids)
    var groupYBounds = filled.map(function(grp) { return getYBoundaries(grp, wh); });

    // Step 3: Compute median right/left per group for robust x-boundaries
    var groupMedianRight = filled.map(function(grp) {
        var rs = grp.map(function(a){return a.right;}).sort(function(a,b){return a-b;});
        return rs[Math.floor(rs.length/2)];
    });
    var groupMedianLeft = filled.map(function(grp) {
        var ls = grp.map(function(a){return a.left;}).sort(function(a,b){return a-b;});
        return ls[Math.floor(ls.length/2)];
    });

    // Estimate target cell dimensions (for the output rectangle)
    var sampleSps = [];
    for (var si = 1; si < filled[0].length; si++) sampleSps.push(filled[0][si].y - filled[0][si-1].y);
    var medRowH = sampleSps.sort(function(a,b){return a-b;})[Math.floor(sampleSps.length/2)];
    var targetH = Math.round(medRowH * 0.9); // slightly smaller than full row height
    if (targetH < 20) targetH = 40;

    log('  Target cell height: '+targetH+'px (median row spacing='+Math.round(medRowH)+')','dim');

    // Step 4: Compute content width from first group (for reuse by last group)
    var medContentWidth = 0;
    if (numGroups >= 2) {
        var cwArr = [];
        for (var wi = 0; wi < Math.min(filled[0].length, filled[1].length); wi++) {
            cwArr.push(filled[1][wi].left - filled[0][wi].right);
        }
        cwArr.sort(function(a,b){return a-b;});
        medContentWidth = cwArr[Math.floor(cwArr.length/2)];
        log('  Median content width (group boundary): '+Math.round(medContentWidth)+'px','dim');
    }

    // Step 5: Compute slope per adjacent group pair + inter-group x-distance
    // Slope must be SCALED when applied to cell width (which is much smaller than group distance)
    var pairSlopes = []; // pairSlopes[g][i] = y-offset from group g to group g+1 at boundary i
    var pairXDists = []; // x-distance between group centroids
    var groupMedianX = filled.map(function(grp) {
        var xs = grp.map(function(a){return a.x;}).sort(function(a,b){return a-b;});
        return xs[Math.floor(xs.length/2)];
    });
    for (var psi = 0; psi < numGroups - 1; psi++) {
        var minBLen = Math.min(groupYBounds[psi].length, groupYBounds[psi+1].length);
        var slopes = [];
        for (var psj = 0; psj < minBLen; psj++) {
            slopes.push(groupYBounds[psi+1][psj] - groupYBounds[psi][psj]);
        }
        pairSlopes.push(slopes);
        pairXDists.push(Math.abs(groupMedianX[psi+1] - groupMedianX[psi]));
    }
    if (pairSlopes.length > 0) {
        var avgSlope = pairSlopes[0].reduce(function(a,b){return a+b;},0)/pairSlopes[0].length;
        log('  Slope ref (pair 0->1): avg='+avgSlope.toFixed(1)+'px over '+Math.round(pairXDists[0])+'px x-distance','dim');
        // Show per-row slopes to diagnose corner overshoot
        var slopeSummary = pairSlopes[0].map(function(s,idx){return 'r'+idx+'='+s.toFixed(1);});
        log('  Per-row slopes: '+slopeSummary.join(' '),'dim');
    }

    // Step 6: For each cell, compute 4 corners and mini-warp
    for (var g = 0; g < numGroups; g++) {
        var grp = filled[g];
        var yBoundsG = groupYBounds[g];
        var nextGrp = (g + 1 < numGroups) ? filled[g + 1] : null;
        var yBoundsNext = (g + 1 < numGroups) ? groupYBounds[g + 1] : null;
        var isLastGroup = (g === numGroups - 1);
        var moveOffset = g * rowCount;
        var lastPairIdx = Math.max(0, numGroups - 2);

        for (var i = 0; i < rowCount && i < yBoundsG.length - 1; i++) {
            // X-boundaries
            var xLeft = grp[i].right + numPadRight;
            var xRight;
            if (nextGrp && i < nextGrp.length) {
                xRight = nextGrp[i].left - padX;
            } else if (isLastGroup && medContentWidth > 0) {
                // Last group: use same content width as first group
                xRight = xLeft + medContentWidth - numPadRight - padX;
                xRight = Math.min(xRight, ww - padX);
            } else {
                xRight = ww - padX;
            }
            if (xRight <= xLeft + 20) continue;

            var xMid = (xLeft + xRight) / 2;

            // Y-boundaries at left edge (from this group)
            var yTopLeft = yBoundsG[i];
            var yBotLeft = yBoundsG[i + 1];

            // Y-boundaries at right edge
            var yTopRight, yBotRight;
            if (yBoundsNext && i + 1 < yBoundsNext.length) {
                // Have next group's anchors — use them for slope
                yTopRight = yBoundsNext[i];
                yBotRight = yBoundsNext[i + 1];
            } else if (isLastGroup && pairSlopes.length > 0 && pairXDists[lastPairIdx] > 0) {
                // Last group: apply slope from previous pair, SCALED by cell width / group distance
                var cellWidth = xRight - xLeft;
                var slopeScale = cellWidth / pairXDists[lastPairIdx];
                var sRef = pairSlopes[lastPairIdx];
                yTopRight = yBoundsG[i] + (sRef[Math.min(i, sRef.length-1)] * slopeScale);
                yBotRight = yBoundsG[i+1] + (sRef[Math.min(i+1, sRef.length-1)] * slopeScale);
            } else {
                yTopRight = yTopLeft;
                yBotRight = yBotLeft;
            }

            // Y at midpoint (linear interpolation)
            var yTopMid = (yTopLeft + yTopRight) / 2;
            var yBotMid = (yBotLeft + yBotRight) / 2;

            var moveNum = i + 1 + moveOffset;
            if (moveNum > rowCount * numGroups) continue;

            // Debug: log cell corners for last row of each group to compare slopes
            if (i === rowCount - 1) {
                var cellSlopeTop = yTopRight - yTopLeft;
                var cellSlopeBot = yBotRight - yBotLeft;
                var cw = xRight - xLeft;
                log('  Move '+moveNum+' cell: x=['+Math.round(xLeft)+'..'+Math.round(xRight)+'] w='+Math.round(cw)
                    +'px slopeTop='+cellSlopeTop.toFixed(1)+' slopeBot='+cellSlopeBot.toFixed(1)
                    +' (group '+(g+1)+'/'+numGroups+(isLastGroup?' EXTRAP':'')+')', 'dim');
            }
            var targetWHalf = Math.round((xRight - xLeft) / 2);
            if (targetWHalf < 20) targetWHalf = 80;

            // === White cell: [xLeft, xMid] ===
            var wTL = {x: xLeft, y: yTopLeft};
            var wTR = {x: xMid, y: yTopMid};
            var wBL = {x: xLeft, y: yBotLeft};
            var wBR = {x: xMid, y: yBotMid};

            var wCell = miniWarp(srcMat, wTL, wTR, wBR, wBL, targetWHalf, targetH);
            if (wCell) {
                cells.push({
                    moveNumber: moveNum, color: 'w',
                    bbox: {x: Math.round(xLeft), y: Math.round(yTopLeft),
                           width: Math.round(xMid - xLeft), height: Math.round(yBotLeft - yTopLeft)},
                    corners: {TL: wTL, TR: wTR, BR: wBR, BL: wBL},
                    image: wCell
                });
            }

            // === Black cell: [xMid, xRight] ===
            var bTL = {x: xMid, y: yTopMid};
            var bTR = {x: xRight, y: yTopRight};
            var bBL = {x: xMid, y: yBotMid};
            var bBR = {x: xRight, y: yBotRight};

            var bCell = miniWarp(srcMat, bTL, bTR, bBR, bBL, targetWHalf, targetH);
            if (bCell) {
                cells.push({
                    moveNumber: moveNum, color: 'b',
                    bbox: {x: Math.round(xMid), y: Math.round(yTopMid),
                           width: Math.round(xRight - xMid), height: Math.round(yBotRight - yTopMid)},
                    corners: {TL: bTL, TR: bTR, BR: bBR, BL: bBL},
                    image: bCell
                });
            }
        }
    }

    cells.sort(function(a,b) {
        return a.moveNumber !== b.moveNumber ? a.moveNumber - b.moveNumber : (a.color === 'w' ? -1 : 1);
    });
    log('  Extracted '+cells.length+' cells (direct mini-warp from original)','good');
    return cells;
}

function miniWarp(srcMat, TL, TR, BR, BL, dstW, dstH) {
    if (dstW < 5 || dstH < 5) return null;
    try {
        var src = cv.matFromArray(4, 1, cv.CV_32FC2, [
            TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y
        ]);
        var dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0, dstW - 1, 0, dstW - 1, dstH - 1, 0, dstH - 1
        ]);
        var M = cv.getPerspectiveTransform(src, dst);
        var out = new cv.Mat();
        cv.warpPerspective(srcMat, out, M, new cv.Size(dstW, dstH));
        src.delete(); dst.delete(); M.delete();
        return out;
    } catch(e) {
        return null;
    }
}

/**
 * Clean a cell image: remove full-height vertical grid lines.
 * 
 * Vertical grid lines span the full cell height — no handwritten stroke does.
 * Morphological open with a tall narrow kernel isolates only those structures,
 * then we paint them as white (background), leaving handwriting untouched.
 *
 * @param {cv.Mat} cellImg - Cell image (RGBA or grayscale)
 * @param {number} [minLineFrac=0.75] - Min fraction of cell height for line detection
 * @returns {cv.Mat} - Cleaned cell image (caller must delete original if not needed)
 */

function cleanCell(cellImg, minLineFrac) {
    if (!cellImg || cellImg.empty()) return cellImg;
    var ch = cellImg.rows, cw = cellImg.cols;
    if (ch < 10 || cw < 10) return cellImg;

    var frac = minLineFrac || 0.75;
    var kernelH = Math.max(7, Math.round(ch * frac));

    // Convert to grayscale for line detection
    var gray;
    if (cellImg.channels() === 1) {
        gray = cellImg.clone();
    } else {
        gray = new cv.Mat();
        cv.cvtColor(cellImg, gray, cv.COLOR_RGBA2GRAY);
    }

    // Invert: dark lines -> white on black
    var inv = new cv.Mat();
    cv.bitwise_not(gray, inv);
    gray.delete();

    // Morphological open: tall narrow kernel preserves only full-height vertical structures
    var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, kernelH));
    var lineMask = new cv.Mat();
    cv.morphologyEx(inv, lineMask, cv.MORPH_OPEN, kernel);
    kernel.delete();
    inv.delete();

    // Dilate the mask slightly (2-3px) to cover the full line width
    var dilateK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 1));
    var dilated = new cv.Mat();
    cv.dilate(lineMask, dilated, dilateK);
    dilateK.delete();
    lineMask.delete();

    // Check if any lines were found
    var hasLines = false;
    for (var y = 0; y < ch && !hasLines; y++) {
        for (var x = 0; x < cw && !hasLines; x++) {
            if (dilated.ucharAt(y, x) > 128) hasLines = true;
        }
    }

    if (!hasLines) {
        dilated.delete();
        return cellImg;
    }

    // Paint detected line pixels as white in the original image
    var cleaned = cellImg.clone();
    var numChannels = cleaned.channels();
    for (var cy = 0; cy < ch; cy++) {
        for (var cx = 0; cx < cw; cx++) {
            if (dilated.ucharAt(cy, cx) > 128) {
                if (numChannels === 1) {
                    cleaned.ucharPtr(cy, cx)[0] = 255;
                } else {
                    var ptr = cleaned.ucharPtr(cy, cx);
                    ptr[0] = 255; ptr[1] = 255; ptr[2] = 255;
                    if (numChannels === 4) ptr[3] = 255;
                }
            }
        }
    }

    dilated.delete();
    return cleaned;
}

// =============================================================================
// TODO: PIPELINE INTEGRATION REMINDERS
// =============================================================================
// 
// 1. G-TAIL DETECTION (g-tail-detection.js):
//    After cell extraction, apply g-tail detection to each cell.
//    'g' tails bleed into the cell BELOW — the tail from row N's 'g' appears
//    at the top of row N+1's cell. The existing g-tail-detection.js handles this
//    by extending cell boundaries ~15px and detecting tail shapes.
//    -> Must be integrated into extractCellsDirect() or as a post-processing step.
//    -> Consider: with per-cell mini-warps, the tail from row N is captured in
//      row N's cell (good), but may also appear in row N+1's cell (needs cleanup).
//
// 2. VERTICAL LINE REMOVAL (cleanCell above):
//    Call cleanCell() on each extracted cell to remove printed vertical grid lines.
//    The BiLSTM may interpret vertical lines as K, N, B, or R.
//    -> Wire into extractCellsDirect: replace `image: wCell` with 
//      `image: cleanCell(wCell)` and delete the pre-cleaned version.
//    -> In production: make this optional via a setting (some sheets have no 
//      vertical lines, and the morphological op has a small cost).
//
// 3. ANCHOR CC CLEANUP:
//    Some anchor bounding boxes include parts of handwriting that overlap
//    the move number area. The numPadRight=6 helps, but in production,
//    consider morphological cleanup of the anchor region itself.
//
// 4. NUMBER COLUMN IN CELL:
//    Currently we skip the number column entirely (cell starts at anchor.right).
//    If any pipeline needs the number column content (e.g., for validation),
//    extract it separately: x=[anchor.left, anchor.right] for each row.
// =============================================================================

/**
 * Draw the direct grid overlay on the original image.
 * Shows per-cell quadrilaterals with sloped boundaries.
 */


// =============================================================================
// AUTO-FIND (parameter optimization, headless)
// =============================================================================

/**
 * Auto-calibrate clustering parameters for best column detection.
 * Headless adaptation of testbed autoFind() — no DOM references.
 *
 * @param {cv.Mat} srcGray - Grayscale source image
 * @param {cv.Mat} srcMat - RGBA source image (for dimensions)
 * @param {Object} config - {format, rowCount, maxColWidthPct, ...}
 * @param {Function} log - Logging function
 * @returns {Object} - {bestN, bestMinH, bestXW, bestMaxW, bestResult, cands, clResult, binary}
 */
function slideAutoFind(srcGray, srcMat, config, log) {
    var format = config.format || '2col';
    var expCols = format === '3col' ? 3 : 2;
    var maxWP = config.maxColWidthPct || 7;
    var rowCount = config.rowCount || 20;
    var curMinH = config.minDigitH || 0.8;
    var maxHR = (config.maxDigitH || 4.0) / 100;
    var maxWR = (config.maxDigitW || 2.5) / 100;
    var blockPct = config.blockSize || 2.0;
    var curXW = config.xWeight || 4;

    log('\n=== SLIDE AUTO FIND ===');

    function getMinXTight(result) {
        if (!result.details) return 0;
        return Math.min.apply(null, result.details.map(function(d) { return d.scoring.xTight || 0; }));
    }
    function getMinRowEst(result) {
        if (!result.details) return 0;
        return Math.min.apply(null, result.details.map(function(d) { return d.scoring.rowEstimate || 0; }));
    }

    var bestBinary = null;

    function tryCombination(minHR, xW, tryMaxWR) {
        var useMaxWR = tryMaxWR || maxWR;
        var cands = findCandidates(srcGray, {minHR: minHR, maxHR: maxHR, maxWR: useMaxWR, blockPct: blockPct});
        cands.cleaned.delete();
        var cl = singleLinkageClustering(cands.cands, xW);
        var result = autoFindBestCut(cands.cands, cl.edges, srcMat.rows, srcMat.cols, expCols, maxWP, rowCount);
        result.minXT = getMinXTight(result);
        result.minRowEst = getMinRowEst(result);
        return {result: result, cands: cands, cl: cl, minH: minHR * 100, xW: xW, maxWR: useMaxWR};
    }

    // Phase 1: Try with current settings
    var init = tryCombination(curMinH / 100, curXW);
    var bestResult = init.result;
    var bestMinH = curMinH, bestXW = curXW, curMaxW = maxWR * 100, bestMaxW = curMaxW;
    var bestCands = init.cands.cands;
    var bestClResult = init.cl;
    bestBinary = init.cands.binary;

    log('  Initial (minH=' + curMinH + '% xW=' + curXW + '): score=' + bestResult.bestScore.toFixed(2)
        + ' minXTight=' + bestResult.minXT.toFixed(2) + ' ~' + bestResult.minRowEst + 'rows at ' + bestResult.bestN + ' clusters');

    // Phase 2: If x-tightness is low, retry with lower minH%
    if (bestResult.minXT < 0.9 && bestResult.bestScore > 0) {
        var minHSteps = [0.6, 0.4];
        for (var ri = 0; ri < minHSteps.length; ri++) {
            if (minHSteps[ri] >= curMinH) continue;
            log('  Retry minH=' + minHSteps[ri] + '% (xTight=' + bestResult.minXT.toFixed(2) + ' < 0.9)...');
            var trial = tryCombination(minHSteps[ri] / 100, curXW);
            log('    score=' + trial.result.bestScore.toFixed(2) + ' xTight=' + trial.result.minXT.toFixed(2));
            if (trial.result.minXT > bestResult.minXT + 0.05) {
                bestResult = trial.result; bestMinH = minHSteps[ri]; bestXW = curXW;
                if (bestBinary) bestBinary.delete();
                bestBinary = trial.cands.binary;
                bestCands = trial.cands.cands; bestClResult = trial.cl;
            } else { trial.cands.binary.delete(); }
            if (bestResult.minXT >= 0.95) break;
        }
    }

    // Phase 3: If clustering completely failed, retry with higher xWeight
    if (bestResult.bestScore < 0) {
        var xwSteps = [6, 8, 10];
        var minHToTry = [curMinH, 0.6, 0.4];
        log('  Clustering failed — retrying with higher xWeight...');
        for (var xi = 0; xi < xwSteps.length && bestResult.bestScore < 0; xi++) {
            if (xwSteps[xi] <= curXW) continue;
            for (var mi = 0; mi < minHToTry.length; mi++) {
                var tryMinH = minHToTry[mi] / 100;
                log('  Retry xW=' + xwSteps[xi] + ' minH=' + (tryMinH * 100).toFixed(1) + '%...');
                var trial2 = tryCombination(tryMinH, xwSteps[xi]);
                log('    score=' + trial2.result.bestScore.toFixed(2) + ' xTight=' + trial2.result.minXT.toFixed(2)
                    + ' (' + trial2.cands.cands.length + ' cands)');
                if (trial2.result.bestScore > 0 && trial2.result.minXT > bestResult.minXT) {
                    bestResult = trial2.result; bestMinH = tryMinH * 100; bestXW = xwSteps[xi];
                    if (bestBinary) bestBinary.delete();
                    bestBinary = trial2.cands.binary;
                    bestCands = trial2.cands.cands; bestClResult = trial2.cl;
                    if (bestResult.minXT >= 0.95) break;
                } else { trial2.cands.binary.delete(); }
            }
        }
    }

    // Phase 4: If columns estimate too few rows, retry with higher Max W%
    if (bestResult.bestScore > 0 && bestResult.minRowEst < rowCount - 1) {
        var maxWSteps = [3.5, 4.5];
        log('  Columns estimate ~' + bestResult.minRowEst + ' rows (need ' + rowCount + ') — retrying with higher maxW%...');
        for (var wi = 0; wi < maxWSteps.length; wi++) {
            if (maxWSteps[wi] <= curMaxW) continue;
            var tryMaxWR = maxWSteps[wi] / 100;
            log('  Retry maxW=' + maxWSteps[wi] + '%...');
            var trial4 = tryCombination(bestMinH / 100, bestXW, tryMaxWR);
            log('    score=' + trial4.result.bestScore.toFixed(2) + ' ~' + trial4.result.minRowEst + 'rows'
                + ' xTight=' + trial4.result.minXT.toFixed(2) + ' (' + trial4.cands.cands.length + ' cands)');
            if (trial4.result.bestScore > 0 && trial4.result.minRowEst > bestResult.minRowEst
                && trial4.result.minXT >= 0.9) {
                bestResult = trial4.result; bestMaxW = maxWSteps[wi];
                if (bestBinary) bestBinary.delete();
                bestBinary = trial4.cands.binary;
                bestCands = trial4.cands.cands; bestClResult = trial4.cl;
                if (bestResult.minRowEst >= rowCount) break;
            } else { trial4.cands.binary.delete(); }
        }
    }

    log('Best cut: ' + bestResult.bestN + ' clusters (score=' + bestResult.bestScore.toFixed(2)
        + ', minXTight=' + (bestResult.minXT || 0).toFixed(2) + ')');

    return {
        bestN: bestResult.bestN,
        bestResult: bestResult,
        bestMinH: bestMinH,
        bestXW: bestXW,
        bestMaxW: bestMaxW,
        cands: bestCands,
        clResult: bestClResult,
        binary: bestBinary
    };
}

// =============================================================================
// MAIN SLIDE PIPELINE
// =============================================================================

/**
 * Run the full slide pipeline on a preprocessed image.
 *
 * @param {cv.Mat} srcMat - Source RGBA image (may be cropped/color-stripped)
 * @param {cv.Mat} srcGray - Grayscale of srcMat
 * @param {cv.Mat} binary - Binary thresholded image (for hole analysis)
 * @param {Object} autoResult - From slideAutoFind()
 * @param {Object} config - {format, rowCount, maxColWidthPct, pageType, ...}
 * @param {Function} log - Logging function
 * @returns {Object|null} - {cells, colR, method:'slide'} or null on failure
 */
function slideRunPipeline(srcMat, srcGray, binary, autoResult, config, log) {
    var format = config.format || '2col';
    var rowCount = config.rowCount || 20;
    var numClusters = autoResult.bestN;
    var maxWP = config.maxColWidthPct || 7;
    var expCols = format === '3col' ? 3 : 2;
    var isBackPage = (config.pageType === 'back');

    var frontRows = config.frontRows || rowCount;
    log('\n=== SLIDE PIPELINE (clusters=' + numClusters + ') ===');
    log('  Image: ' + srcMat.cols + 'x' + srcMat.rows + ' | format=' + format + ' rows=' + rowCount
        + (isBackPage ? ' (BACK page, front=' + frontRows + ')' : '') + ' maxColW=' + maxWP + '%');

    // Extract clusters at the chosen N
    var clusters = extractClustersAtN(autoResult.cands, autoResult.clResult.edges, numClusters);
    var scored = clusters.map(function(c) { return scoreCluster(c, srcMat.rows, srcMat.cols, maxWP, rowCount); });

    // Diagnostic: log top clusters
    var idxS = clusters.map(function(c, i) { return {idx: i, n: c.length, sc: scored[i]}; });
    idxS.sort(function(a, b) { return b.sc.score - a.sc.score; });
    for (var di = 0; di < Math.min(5, idxS.length); di++) {
        var d = idxS[di];
        if (d.sc.score > 0) log('  Cl' + d.idx + ': n=' + d.n + ' h=' + Math.round(d.sc.height || 0)
            + '(' + Math.round((d.sc.height || 0) / srcMat.rows * 100) + '%) ~' + d.sc.rowEstimate + 'rows'
            + ' xStd=' + d.sc.xStd + '(t=' + d.sc.xTight + ') hC=' + d.sc.hConsistency
            + ' gM=' + d.sc.gapMultipleScore + (d.sc.rowPenalty < 1 ? ' rP=' + d.sc.rowPenalty : '')
            + ' s=' + d.sc.score.toFixed(2));
    }

    // Quality-gated merge
    var indexed = clusters.map(function(c, i) { return {cl: c, score: scored[i].score, scoring: scored[i]}; });
    indexed.sort(function(a, b) { return b.score - a.score; });
    var good = indexed.filter(function(it) { return it.score > 0; });
    var mergeT = srcMat.cols * 0.04, merged = [], mU = new Array(good.length).fill(false);
    for (var mi = 0; mi < good.length; mi++) {
        if (mU[mi]) continue;
        var grp = [good[mi]]; mU[mi] = true;
        var bx = good[mi].cl.reduce(function(s, c) { return s + c.cx; }, 0) / good[mi].cl.length;
        for (var mj = mi + 1; mj < good.length; mj++) {
            if (mU[mj]) continue;
            var ox = good[mj].cl.reduce(function(s, c) { return s + c.cx; }, 0) / good[mj].cl.length;
            if (Math.abs(ox - bx) < mergeT) { grp.push(good[mj]); mU[mj] = true; }
        }
        if (grp.length === 1) { merged.push(grp[0].cl); continue; }

        // If the group has more clusters than expected columns, it may have swallowed
        // clusters from adjacent columns. Split at the largest x-gap to form sub-groups.
        if (grp.length > expCols) {
            var grpCxs = grp.map(function(g) {
                return {g: g, cx: g.cl.reduce(function(s, c) { return s + c.cx; }, 0) / g.cl.length};
            });
            grpCxs.sort(function(a, b) { return a.cx - b.cx; });
            var maxGap = 0, maxGapIdx = 0;
            for (var ggi = 1; ggi < grpCxs.length; ggi++) {
                var gap = grpCxs[ggi].cx - grpCxs[ggi - 1].cx;
                if (gap > maxGap) { maxGap = gap; maxGapIdx = ggi; }
            }
            // Only split if the gap is meaningful (at least 2% of image width)
            var minSplitGap = srcMat.cols * 0.02;
            if (maxGap >= minSplitGap) {
                var subA = grpCxs.slice(0, maxGapIdx).map(function(g) { return g.g; });
                var subB = grpCxs.slice(maxGapIdx).map(function(g) { return g.g; });
                log('  Split merge group of ' + grp.length + ' at x-gap ' + Math.round(maxGap) + 'px → ' + subA.length + '+' + subB.length);
                grp = subA;
                for (var sbi = 0; sbi < subB.length; sbi++) {
                    for (var sbj = 0; sbj < good.length; sbj++) {
                        if (good[sbj] === subB[sbi] && mU[sbj]) { mU[sbj] = false; break; }
                    }
                }
            } else {
                log('  Merge group of ' + grp.length + ': gap ' + Math.round(maxGap) + 'px < min ' + Math.round(minSplitGap) + 'px — merging all');
            }
        }

        if (grp.length === 1) { merged.push(grp[0].cl); continue; }
        // Quality-gated merge: check if merged result preserves regularity
        var baseScoring = grp[0].scoring;
        var flat = []; grp.forEach(function(g) { flat = flat.concat(g.cl); });
        var mergedScoring = scoreCluster(flat, srcMat.rows, srcMat.cols, maxWP, rowCount);
        // Accept merge if regularity metrics don't degrade badly
        var mergeOK = mergedScoring.score > 0; // must be a valid cluster at all
        if (mergeOK) {
            var hcOK = mergedScoring.hConsistency >= baseScoring.hConsistency * 0.80;
            var gmOK = mergedScoring.gapMultipleScore >= baseScoring.gapMultipleScore * 0.80;
            mergeOK = hcOK && gmOK;
        }
        if (mergeOK) {
            merged.push(flat);
            log('  Merged ' + grp.length + ' → ' + flat.length + ' (hC=' + mergedScoring.hConsistency
                + ' gM=' + mergedScoring.gapMultipleScore + ')');
        } else {
            log('  Merge REJECTED ' + grp.length + ' clusters (hC: ' + baseScoring.hConsistency + '→' + mergedScoring.hConsistency
                + ', gM: ' + baseScoring.gapMultipleScore + '→' + mergedScoring.gapMultipleScore + ') — keeping separate');
            for (var gi = 0; gi < grp.length; gi++) merged.push(grp[gi].cl);
        }
    }
    var mS = merged.map(function(c) { return scoreCluster(c, srcMat.rows, srcMat.cols, maxWP, rowCount); });
    var mI = merged.map(function(c, i) { return {cl: c, score: mS[i].score}; });
    mI.sort(function(a, b) { return b.score - a.score; });
    var top = mI.slice(0, expCols).filter(function(it) { return it.score > 0; }).map(function(it) { return it.cl; });
    top.sort(function(a, b) {
        return (a.reduce(function(s, c) { return s + c.cx; }, 0) / a.length)
             - (b.reduce(function(s, c) { return s + c.cx; }, 0) / b.length);
    });
    log('Selected ' + top.length + ' columns');
    if (top.length < 2) { log('Need ≥2 columns!'); return null; }

    // === Short-cluster rescue: absorb rejected-as-short clusters that are x-aligned ===
    // When a column's anchors get split across clusters, the smaller fragment may be
    // rejected as too short. Try merging it back in if regularity is preserved.
    // ONLY attempt if the column's row estimate is significantly below expected rowCount.
    var mergeT2 = srcMat.cols * 0.04;
    for (var si = 0; si < top.length; si++) {
        var colScoring = scoreCluster(top[si], srcMat.rows, srcMat.cols, maxWP, rowCount);
        // Skip if column already has enough rows (within 3 of target)
        if (colScoring.rowEstimate >= rowCount - 3) continue;
        var colCx = top[si].reduce(function(s, c) { return s + c.cx; }, 0) / top[si].length;
        for (var sj = 0; sj < clusters.length; sj++) {
            if (scored[sj].score > 0) continue;
            if (scored[sj].reason && scored[sj].reason.indexOf('short') < 0) continue;
            if (clusters[sj].length < 3) continue;
            var rejCx = clusters[sj].reduce(function(s, c) { return s + c.cx; }, 0) / clusters[sj].length;
            if (Math.abs(rejCx - colCx) > mergeT2) continue;
            var trial = top[si].concat(clusters[sj]);
            var trialScoring = scoreCluster(trial, srcMat.rows, srcMat.cols, maxWP, rowCount);
            if (trialScoring.score <= 0) continue;
            var hcOK = trialScoring.hConsistency >= colScoring.hConsistency * 0.80;
            var gmOK = trialScoring.gapMultipleScore >= colScoring.gapMultipleScore * 0.80;
            if (hcOK && gmOK) {
                top[si] = trial;
                colScoring = trialScoring;
                log('  Col' + (si + 1) + ': rescued short cluster (n=' + clusters[sj].length + ') → '
                    + top[si].length + ' total (hC=' + trialScoring.hConsistency + ' gM=' + trialScoring.gapMultipleScore + ')');
                if (colScoring.rowEstimate >= rowCount - 3) break;
            }
        }
    }

    // === Right-side digit rescue: absorb companion digits immediately to the right ===
    // For multi-digit move numbers (10+), the tens and units digits may end up in
    // separate clusters. The units cluster often scores 0 (too short on back pages).
    // This rescue pass looks through ALL candidates for CCs that:
    //   - are immediately to the RIGHT of existing column CCs (tight x-distance)
    //   - have matching height (same printed font)
    //   - have digit-like width (not a wide handwritten letter)
    //   - align in y with an existing row (max 1 per row)
    var usedCCs = new Set();
    for (var ui = 0; ui < top.length; ui++)
        for (var uj = 0; uj < top[ui].length; uj++) usedCCs.add(top[ui][uj]);

    for (var ri = 0; ri < top.length; ri++) {
        var col = top[ri];
        var colHs = col.map(function(c) { return c.h; }).sort(function(a, b) { return a - b; });
        var colWs = col.map(function(c) { return c.w; }).sort(function(a, b) { return a - b; });
        var medColH = colHs[Math.floor(colHs.length / 2)];
        var medColW = colWs[Math.floor(colWs.length / 2)];
        var hTolLo = medColH * 0.55, hTolHi = medColH * 1.45;
        var wTolHi = medColW * 1.5;
        var xMaxGap = medColW * 1.0;

        var colSorted = col.slice().sort(function(a, b) { return a.cy - b.cy; });
        var yTolR = medColH * 0.6;
        var rowGroups = [[colSorted[0]]];
        for (var rk = 1; rk < colSorted.length; rk++) {
            var lastG = rowGroups[rowGroups.length - 1];
            if (colSorted[rk].cy - lastG[lastG.length - 1].cy <= yTolR) lastG.push(colSorted[rk]);
            else rowGroups.push([colSorted[rk]]);
        }

        var rescued = 0;
        for (var rg = 0; rg < rowGroups.length; rg++) {
            var row = rowGroups[rg];
            var rightmost = row.reduce(function(best, c) { return c.cx > best.cx ? c : best; }, row[0]);
            var rightEdge = rightmost.x + rightmost.w;
            var rowMeanY = row.reduce(function(s, c) { return s + c.cy; }, 0) / row.length;

            var rowRescued = false;
            for (var ci = 0; ci < autoResult.cands.length; ci++) {
                if (rowRescued) break;
                var cc = autoResult.cands[ci];
                if (usedCCs.has(cc)) continue;
                if (cc.x < rightEdge - 5) continue;
                if (cc.x - rightEdge > xMaxGap) continue;
                if (Math.abs(cc.cy - rowMeanY) > yTolR) continue;
                if (cc.h < hTolLo || cc.h > hTolHi) continue;
                if (cc.w > wTolHi) continue;
                col.push(cc);
                usedCCs.add(cc);
                rescued++;
                rowRescued = true;
            }
        }
        if (rescued > 0) {
            log('  Col' + (ri + 1) + ': rescued ' + rescued + ' right-side companion digit(s)');
        }
    }

    // === Trim clusters: singleton removal + header/footer classification + hole alignment ===
    var colAlignments = [];
    for (var ti = 0; ti < top.length; ti++) {
        var clSorted = top[ti].slice().sort(function(a, b) { return a.cy - b.cy; });
        var avgH = clSorted.reduce(function(s, c) { return s + c.h; }, 0) / clSorted.length;
        var yTol = avgH * 0.6;
        var grps = [[clSorted[0]]];
        for (var gi2 = 1; gi2 < clSorted.length; gi2++) {
            var last = grps[grps.length - 1];
            if (clSorted[gi2].cy - last[last.length - 1].cy <= yTol) last.push(clSorted[gi2]);
            else grps.push([clSorted[gi2]]);
        }
        var rYs = grps.map(function(g) { return g.reduce(function(s, c) { return s + c.cy; }, 0) / g.length; });
        var rCounts = grps.map(function(g) { return g.length; });

        // Absorb squeezed singletons
        if (rYs.length >= 5) {
            var trimGaps = [];
            for (var tgi = 1; tgi < rYs.length; tgi++) trimGaps.push(rYs[tgi] - rYs[tgi - 1]);
            var trimMed = trimGaps.slice().sort(function(a, b) { return a - b; })[Math.floor(trimGaps.length / 2)];
            for (var si = rYs.length - 2; si >= 1; si--) {
                if (rCounts[si] <= 1) {
                    var gapBefore = rYs[si] - rYs[si - 1];
                    var gapAfter = rYs[si + 1] - rYs[si];
                    var totalGap = gapBefore + gapAfter;
                    if (totalGap < trimMed * 1.4 && totalGap > trimMed * 0.6) {
                        var removedItems = grps[si];
                        for (var ri = 0; ri < removedItems.length; ri++) {
                            var idx = top[ti].indexOf(removedItems[ri]);
                            if (idx >= 0) top[ti].splice(idx, 1);
                        }
                        log('  Col' + (ti + 1) + ': remove singleton at y≈' + Math.round(rYs[si]));
                        rYs.splice(si, 1);
                        rCounts.splice(si, 1);
                        grps.splice(si, 1);
                    }
                }
            }
        }

        // Width-based header/footer classification
        var rowStatsForClassify = grps.map(function(g, ri2) {
            var cy2 = g.reduce(function(s, c) { return s + c.cy; }, 0) / g.length;
            var hArr = g.map(function(c) { return c.h; }).sort(function(a, b) { return a - b; });
            var medH2 = hArr[Math.floor(hArr.length / 2)];
            var tw = Math.max.apply(null, g.map(function(c) { return c.x + c.w; }))
                   - Math.min.apply(null, g.map(function(c) { return c.x; }));
            return {cy: cy2, medH: medH2, totalW: tw, count: g.length, group: g};
        });

        var classification = classifyClusterRows(rowStatsForClassify, rowCount, log, 'Col' + (ti + 1), ti, isBackPage);

        // Hole-based alignment
        if (binary) {
            var frontCols = (format === '3col') ? 3 : 2;
            var colStartNum;
            if (isBackPage) {
                colStartNum = frontCols * frontRows + ti * rowCount + 1;
            } else {
                colStartNum = ti * rowCount + 1;
            }

            var dataGrpIndices = [];
            for (var dgi = 0; dgi < grps.length; dgi++) {
                if (classification.headerRows.indexOf(dgi) < 0 &&
                    classification.footerRows.indexOf(dgi) < 0) {
                    dataGrpIndices.push(dgi);
                }
            }
            var holeDataForAlign = dataGrpIndices.map(function(idx2) {
                return analyzeRowHoles(binary, grps[idx2]);
            });
            var rowYsForAlign = dataGrpIndices.map(function(idx2) {
                return grps[idx2].reduce(function(s, c) { return s + c.cy; }, 0) / grps[idx2].length;
            });
            var alignment = alignColumnByHoles(
                holeDataForAlign, rowYsForAlign, rowCount,
                (ti === 0 && !isBackPage),
                isBackPage, ti, format, log, 'Col' + (ti + 1), frontRows
            );
            colAlignments.push({
                alignment: alignment,
                dataGrpIndices: dataGrpIndices,
                grps: grps,
                colIdx: ti
            });
        } else {
            colAlignments.push(null);
        }

        // Remove header/footer CCs from cluster
        if (classification.headerRows.length > 0 || classification.footerRows.length > 0) {
            var removeIndices = classification.headerRows.concat(classification.footerRows);
            var removedCount = 0;
            for (var rri = 0; rri < removeIndices.length; rri++) {
                var rowIdx = removeIndices[rri];
                var rowGrp = grps[rowIdx];
                for (var rgi = 0; rgi < rowGrp.length; rgi++) {
                    var cidx = top[ti].indexOf(rowGrp[rgi]);
                    if (cidx >= 0) { top[ti].splice(cidx, 1); removedCount++; }
                }
            }
            if (removedCount > 0) {
                log('  Col' + (ti + 1) + ': removed ' + removedCount + ' CCs ('
                    + classification.headerRows.length + ' header + '
                    + classification.footerRows.length + ' footer)');
            }
        }
    }

    // === Alignment-driven row building ===
    log('\n[Alignment Rows] Building from hole alignment...');

    var colR = [];
    for (var ari = 0; ari < top.length; ari++) {
        var ca = colAlignments[ari];
        if (!ca || !ca.alignment || !ca.alignment.slots) {
            log('  Col' + (ari + 1) + ': alignment unavailable, fallback to buildRowsFromCluster');
            colR.push(buildRowsFromCluster(top[ari], rowCount));
            continue;
        }

        var align = ca.alignment;
        var slots = align.slots;
        var sa = align.slotAssignment;
        var grpsRef = ca.grps;
        var dgiRef = ca.dataGrpIndices;

        function rowFromGroup(g) {
            return {
                y: g.reduce(function(s, c) { return s + c.cy; }, 0) / g.length,
                x: g.reduce(function(s, c) { return s + c.cx; }, 0) / g.length,
                left: Math.min.apply(null, g.map(function(c) { return c.x; })),
                right: Math.max.apply(null, g.map(function(c) { return c.x + c.w; })),
                top: Math.min.apply(null, g.map(function(c) { return c.y; })),
                bottom: Math.max.apply(null, g.map(function(c) { return c.y + c.h; })),
                count: g.length
            };
        }

        // Step 1: Collect DATA slots
        var dataSlots = [];
        for (var dsi = 0; dsi < Math.min(sa.length, slots.length); dsi++) {
            if (sa[dsi].num === null) continue;
            var slotRef = slots[dsi];
            var rowObj = null;
            if (slotRef.filled && slotRef.obsIdx >= 0 && slotRef.obsIdx < dgiRef.length) {
                var grpIdx = dgiRef[slotRef.obsIdx];
                if (grpIdx < grpsRef.length) {
                    rowObj = rowFromGroup(grpsRef[grpIdx]);
                }
            }
            dataSlots.push({ slot: slotRef, num: sa[dsi].num, rowObj: rowObj });
        }

        // Step 2: Prepend head-truncated rows
        for (var ht = align.headTrunc - 1; ht >= 0; ht--) {
            dataSlots.unshift({ slot: {filled: false, y: null}, num: align.startNum + ht, rowObj: null });
        }

        // Step 3: Append tail-truncated rows
        var lastDataNum = dataSlots.length > 0 ? dataSlots[dataSlots.length - 1].num : align.startNum - 1;
        var endNum = align.startNum + rowCount - 1;
        for (var tt = lastDataNum + 1; tt <= endNum; tt++) {
            dataSlots.push({ slot: {filled: false, y: null}, num: tt, rowObj: null });
        }
        if (dataSlots.length > rowCount) dataSlots = dataSlots.slice(0, rowCount);

        // Step 4: Build rows with interpolation/extrapolation
        var filledRefs = [];
        for (var fi = 0; fi < dataSlots.length; fi++) {
            if (dataSlots[fi].rowObj) filledRefs.push({idx: fi, row: dataSlots[fi].rowObj});
        }

        function blendRows(rA, rB, frac) {
            return {
                y: rA.y + frac * (rB.y - rA.y),
                x: rA.x + frac * (rB.x - rA.x),
                left: rA.left + frac * (rB.left - rA.left),
                right: rA.right + frac * (rB.right - rA.right),
                top: rA.top + frac * (rB.top - rA.top),
                bottom: rA.bottom + frac * (rB.bottom - rA.bottom),
                count: 0, interpolated: true
            };
        }

        function extrapRow(rRef, rRef2, steps) {
            var dy = rRef.y - rRef2.y;
            var dx = rRef.x - rRef2.x;
            var dl = rRef.left - rRef2.left;
            var dr = rRef.right - rRef2.right;
            var dt = rRef.top - rRef2.top;
            var db = rRef.bottom - rRef2.bottom;
            return {
                y: rRef.y + steps * dy, x: rRef.x + steps * dx,
                left: rRef.left + steps * dl, right: rRef.right + steps * dr,
                top: rRef.top + steps * dt, bottom: rRef.bottom + steps * db,
                count: 0, interpolated: true
            };
        }

        var rows = [];
        for (var ri2 = 0; ri2 < dataSlots.length; ri2++) {
            if (dataSlots[ri2].rowObj) {
                var r = dataSlots[ri2].rowObj;
                r.interpolated = false;
                rows.push(r);
            } else if (filledRefs.length >= 2) {
                var above = null, below = null;
                for (var ni = 0; ni < filledRefs.length; ni++) {
                    if (filledRefs[ni].idx < ri2) above = filledRefs[ni];
                    if (filledRefs[ni].idx > ri2 && below === null) below = filledRefs[ni];
                }
                if (above && below) {
                    var frac = (ri2 - above.idx) / (below.idx - above.idx);
                    rows.push(blendRows(above.row, below.row, frac));
                } else if (above) {
                    var prev = null;
                    for (var pi = filledRefs.length - 1; pi >= 0; pi--) {
                        if (filledRefs[pi].idx < above.idx) { prev = filledRefs[pi]; break; }
                    }
                    if (prev) {
                        var stepsPerIdx = 1.0 / (above.idx - prev.idx);
                        rows.push(extrapRow(above.row, prev.row, (ri2 - above.idx) * stepsPerIdx));
                    } else {
                        rows.push(extrapRow(above.row, above.row, 0));
                    }
                } else if (below) {
                    var next = null;
                    for (var ni2 = 0; ni2 < filledRefs.length; ni2++) {
                        if (filledRefs[ni2].idx > below.idx) { next = filledRefs[ni2]; break; }
                    }
                    if (next) {
                        var stepsPerIdx2 = 1.0 / (next.idx - below.idx);
                        rows.push(extrapRow(below.row, next.row, (below.idx - ri2) * stepsPerIdx2));
                    } else {
                        rows.push(extrapRow(below.row, below.row, 0));
                    }
                } else {
                    rows.push({y: 0, x: 0, left: 0, right: 0, top: 0, bottom: 0, count: 0, interpolated: true});
                }
            } else if (filledRefs.length === 1) {
                var ref = filledRefs[0];
                var estSpacing = 50;
                rows.push({
                    y: ref.row.y + (ri2 - ref.idx) * estSpacing,
                    x: ref.row.x, left: ref.row.left, right: ref.row.right,
                    top: ref.row.top + (ri2 - ref.idx) * estSpacing,
                    bottom: ref.row.bottom + (ri2 - ref.idx) * estSpacing,
                    count: 0, interpolated: true
                });
            }
        }

        colR.push(rows);
        var filledCount = rows.filter(function(r) { return !r.interpolated; }).length;
        log('  Col' + (ari + 1) + ': ' + rows.length + ' rows (' + filledCount + ' filled, '
            + (rows.length - filledCount) + ' interpolated)');
    }

    log('  Final: ' + colR.map(function(r, i) { return 'Col' + (i + 1) + '=' + r.length; }).join(', '));

    // === Direct cell extraction (no global warp) ===
    log('\n[Direct] Extracting cells from original image (no global warp)...');
    var cells = extractCellsDirect(srcMat, colR, rowCount, format, log);
    log('  ' + cells.length + ' cells');

    return {
        cells: cells,
        colR: colR,
        method: 'slide'
    };
}


// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Process a scoresheet image using the slide method.
 * This is the main entry point for integration with opencv_image_processor.js.
 *
 * @param {cv.Mat} srcMat - Source RGBA image
 * @param {Object} config - {format:'2col'|'3col', rowCount:20, pageType:'front'|'back',
 *                           frontRows:20 (rows/col on front page, for back page numbering),
 *                           stripColors:false, satThreshold:50, maxColWidthPct:7,
 *                           minDigitH:0.8, maxDigitH:4.0, maxDigitW:2.5,
 *                           blockSize:2.0, xWeight:4}
 * @param {Function} [log] - Logging function (default: console.log)
 * @returns {Object|null} - {cells: [{moveNumber, color, image: cv.Mat, bbox}], colR, method:'slide'}
 *                          or null on failure. Caller must delete cell images when done.
 */
function slideProcessScoresheet(srcMat, config, log) {
    log = log || function(msg) { console.log('[Slide] ' + msg); };
    config = config || {};

    var srcGray = new cv.Mat();
    cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);

    // Smart crop
    var crop = smartCrop(srcGray);
    var croppedMat, croppedGray;
    if (crop.cropped) {
        log('[Slide] Smart crop: ' + crop.w + 'x' + crop.h
            + ' (' + Math.round(crop.w * crop.h / (srcMat.cols * srcMat.rows) * 100) + '% of original)');
        var rect = new cv.Rect(crop.x, crop.y, crop.w, crop.h);
        croppedMat = srcMat.roi(rect).clone();
        croppedGray = srcGray.roi(rect).clone();
        srcGray.delete();
    } else {
        croppedMat = srcMat.clone();
        croppedGray = srcGray;
    }

    // Optional color stripping
    if (config.stripColors) {
        var cfResult = stripColoredMarks(croppedMat, config.satThreshold || 50);
        croppedMat.delete();
        croppedMat = cfResult.cleaned;
        croppedGray.delete();
        croppedGray = new cv.Mat();
        cv.cvtColor(croppedMat, croppedGray, cv.COLOR_RGBA2GRAY);
    }

    // Auto-find best clustering parameters
    var autoResult = slideAutoFind(croppedGray, croppedMat, config, log);

    if (autoResult.bestResult.bestScore < 0) {
        log('[Slide] Detection failed — no valid column clusters found');
        croppedMat.delete();
        croppedGray.delete();
        if (autoResult.binary) autoResult.binary.delete();
        return null;
    }

    // Run pipeline
    var result = slideRunPipeline(croppedMat, croppedGray, autoResult.binary, autoResult, config, log);

    // Cleanup
    croppedMat.delete();
    croppedGray.delete();
    if (autoResult.binary) autoResult.binary.delete();

    return result;
}


// =============================================================================
// EXPORTS
// =============================================================================
if (typeof window !== 'undefined') {
    window.SlideGrid = {
        processScoresheet: slideProcessScoresheet,
        // Expose internals for testing/debugging
        smartCrop: smartCrop,
        stripColoredMarks: stripColoredMarks,
        findCandidates: findCandidates,
        scoreCluster: scoreCluster,
        alignColumnByHoles: alignColumnByHoles,
        classifyClusterRows: classifyClusterRows,
        extractCellsDirect: extractCellsDirect,
        miniWarp: miniWarp,
        cleanCell: cleanCell
    };
}

})(); // End IIFE
