// =============================================================================
// grid-anchor.js — Anchor-based grid detection (extracted from anchor-testbed-v9l-FINAL.html)
// =============================================================================
// All functions prefixed with 'anchor' to avoid collisions with v34 contour-based grid.
// NO DOM access — `log` is a callback parameter: log(message, cssClass)
// NO caching — caller handles caching.
// NO drawing functions — caller handles visualization.
// =============================================================================

// =============================================================================
// SMART CROP
// =============================================================================
function anchorSmartCrop(grayMat, log) {
    var H = grayMat.rows, W = grayMat.cols;
    var bin = new cv.Mat();
    cv.threshold(grayMat, bin, 230, 255, cv.THRESH_BINARY_INV);

    var brd = Math.max(8, Math.round(Math.min(H, W) * 0.02));
    cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(W, brd), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(0, H - brd), new cv.Point(W, H), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(brd, H), new cv.Scalar(0), -1);
    cv.rectangle(bin, new cv.Point(W - brd, 0), new cv.Point(W, H), new cv.Scalar(0), -1);

    var kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose); kClose.delete();

    var nz = cv.countNonZero(bin);
    log('[SmartCrop] '+W+'x'+H+' thresh=230 border='+brd+'px ink='+nz+' ('+(nz/(H*W)*100).toFixed(1)+'%)','dim');

    if (nz === 0) {
        bin.delete();
        log('[SmartCrop] No ink found — no crop', 'dim');
        return { x: 0, y: 0, w: W, h: H, cropped: false };
    }

    var rowProj = new cv.Mat(), colProj = new cv.Mat();
    cv.reduce(bin, rowProj, 1, cv.REDUCE_MAX);
    cv.reduce(bin, colProj, 0, cv.REDUCE_MAX);

    var top = 0, bot = H - 1, left = 0, right = W - 1;
    while (top < H && rowProj.ucharAt(top, 0) === 0) top++;
    while (bot > top && rowProj.ucharAt(bot, 0) === 0) bot--;
    while (left < W && colProj.ucharAt(0, left) === 0) left++;
    while (right > left && colProj.ucharAt(0, right) === 0) right--;
    rowProj.delete(); colProj.delete(); bin.delete();

    var br = { x: left, y: top, width: right - left + 1, height: bot - top + 1 };

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

// =============================================================================
// STRIP COLORS
// =============================================================================
function anchorStripColors(rgbaMat, satThreshold, log) {
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
// CORE: Connected components, clustering, scoring
// =============================================================================
function anchorFindCandidates(grayMat, opts, log) {
    var H=grayMat.rows,W=grayMat.cols,minH=Math.round(H*(opts.minHR||0.008)),maxH=Math.round(H*(opts.maxHR||0.04));
    var maxW=Math.round(W*(opts.maxWR||0.025));
    var bs=Math.round(H*(opts.blockPct||2)/100);if(bs%2===0)bs++;if(bs<3)bs=3;
    var bin=new cv.Mat();cv.adaptiveThreshold(grayMat,bin,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY_INV,bs,8);
    var k=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(2,2));var cl=new cv.Mat();cv.morphologyEx(bin,cl,cv.MORPH_CLOSE,k);k.delete();
    var lb=new cv.Mat(),st=new cv.Mat(),ct=new cv.Mat();var n=cv.connectedComponentsWithStats(cl,lb,st,ct,8);
    var cands=[],rTooSmall=0,rTooBig=0,rTooWide=0,rTooTall=0,rTooNarrow=0,rTooSparse=0;
    var acceptedHs=[],rejWideHs=[],rejTallHs=[];
    for(var i=1;i<n;i++){var x=st.intAt(i,cv.CC_STAT_LEFT),y=st.intAt(i,cv.CC_STAT_TOP),w=st.intAt(i,cv.CC_STAT_WIDTH),h=st.intAt(i,cv.CC_STAT_HEIGHT),a=st.intAt(i,cv.CC_STAT_AREA);
        if(h<minH){rTooSmall++;continue;}
        if(h>maxH){rTooBig++;continue;}
        if(w>maxW){rTooTall++;rejTallHs.push(h);continue;}
        if(w/h>1.8){rTooWide++;rejWideHs.push(h);continue;}
        if(w/h<0.08){rTooNarrow++;continue;}
        if(a/(w*h)<0.15){rTooSparse++;continue;}
        cands.push({x:x,y:y,w:w,h:h,cx:ct.doubleAt(i,0),cy:ct.doubleAt(i,1),area:a});
        acceptedHs.push(h);}
    log('[CC] '+(n-1)+' components → '+cands.length+' candidates','dim');
    log('  Filters: H:'+minH+'-'+maxH+'px, maxW:'+maxW+'px ('+Math.round(maxW/W*100*10)/10+'%)','dim');
    log('  Reject: small='+rTooSmall+' big='+rTooBig+' wide(ar)='+rTooWide+' wide(abs)='+rTooTall+' narrow='+rTooNarrow+' sparse='+rTooSparse,'dim');
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

function anchorSingleLinkage(cands, xWeight) {
    var n=cands.length,edges=[];
    for(var i=0;i<n;i++)for(var j=i+1;j<n;j++){var dx=(cands[i].cx-cands[j].cx)*xWeight,dy=cands[i].cy-cands[j].cy;edges.push({i:i,j:j,dist:Math.sqrt(dx*dx+dy*dy)});}
    edges.sort(function(a,b){return a.dist-b.dist;});
    var p=new Array(n),rk=new Array(n),sz=new Array(n);for(var k=0;k<n;k++){p[k]=k;rk[k]=0;sz[k]=1;}
    function find(x){while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return false;if(rk[a]<rk[b]){var t=a;a=b;b=t;}p[b]=a;sz[a]+=sz[b];if(rk[a]===rk[b])rk[a]++;return true;}
    var hist=[],nc=n;for(var ei=0;ei<edges.length;ei++){var e=edges[ei];if(find(e.i)!==find(e.j)){union(e.i,e.j);nc--;hist.push({dist:e.dist,nc:nc});}}
    return{hist:hist,edges:edges,n:n};
}

function anchorExtractClusters(cands, edges, targetN) {
    var n=cands.length,p=new Array(n),rk=new Array(n),sz=new Array(n);for(var k=0;k<n;k++){p[k]=k;rk[k]=0;sz[k]=1;}
    function find(x){while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return false;if(rk[a]<rk[b]){var t=a;a=b;b=t;}p[b]=a;sz[a]+=sz[b];if(rk[a]===rk[b])rk[a]++;return true;}
    var nc=n;for(var ei=0;ei<edges.length&&nc>targetN;ei++){if(find(edges[ei].i)!==find(edges[ei].j)){union(edges[ei].i,edges[ei].j);nc--;}}
    var m={};for(var ci=0;ci<n;ci++){var r=find(ci);if(!m[r])m[r]=[];m[r].push(cands[ci]);}
    var cls=Object.values(m);cls.sort(function(a,b){return b.length-a.length;});return cls;
}

function anchorScoreCluster(cl, imgH, imgW, maxColWidthPct, rowCount) {
    if(cl.length<5)return{score:0,reason:'small('+cl.length+')'};
    var xs=cl.map(function(c){return c.cx;}),ys=cl.map(function(c){return c.cy;});
    var xMn=Math.min.apply(null,xs),xMx=Math.max.apply(null,xs),yMn=Math.min.apply(null,ys),yMx=Math.max.apply(null,ys);
    var w=xMx-xMn+1,h=yMx-yMn+1;
    if(w>imgW*maxColWidthPct/100)return{score:0,reason:'wide('+w.toFixed(0)+')'};
    var minHPct = 0.3 * (rowCount || 20) / 20;
    if(h<imgH*minHPct)return{score:0,reason:'short('+Math.round(h/imgH*100)+'%<'+Math.round(minHPct*100)+'%)'};
    ys.sort(function(a,b){return a-b;});var sp=[];for(var i=1;i<ys.length;i++)sp.push(ys[i]-ys[i-1]);
    var rsp=sp.filter(function(s){return s>h*0.02;}),ss=0,rowEst=0;
    if(rsp.length>=5){var med=rsp.slice().sort(function(a,b){return a-b;})[Math.floor(rsp.length/2)];var reg=rsp.filter(function(s){return s>med*0.5&&s<med*1.8;});ss=reg.length/rsp.length;rowEst=Math.round(h/med)+1;}
    var xMean=xs.reduce(function(s,v){return s+v;},0)/xs.length;
    var xVar=xs.reduce(function(s,v){return s+Math.pow(v-xMean,2);},0)/xs.length;
    var xStd=Math.sqrt(xVar);
    var xStdPct=xStd/imgW;
    var xTight=1-Math.min(1,Math.max(0,(xStdPct-0.008)/0.025));
    var ar=h/Math.max(1,w),sf=Math.min(cl.length,50)/50,idealH=imgH*0.6*(rowCount||20)/20,hf=Math.min(h/idealH,1.0);
    var score=ar*sf*hf*(0.5+0.5*ss)*(0.5+0.5*xTight);
    return{score:score,width:w,height:h,aspectRatio:ar,spacingScore:ss,rowEstimate:rowEst,xStd:Math.round(xStd),xTight:Math.round(xTight*100)/100,reason:'ok'};
}

function anchorAutoFindBestCut(cands, edges, imgH, imgW, expCols, maxColWidthPct, rowCount, log) {
    var best=-1,bestN=2,bestD=null,maxN=Math.min(cands.length,120);
    var mergeT=imgW*0.04;
    var dbg={tried:0,noScore:0,badRows:0,tooClose:0,tooNarrow:0,badHtR:0,scored:0};
    for(var t=maxN;t>=2;t--){
        dbg.tried++;
        var cls=anchorExtractClusters(cands,edges,t);
        var sc=cls.map(function(c){return{cluster:c,scoring:anchorScoreCluster(c,imgH,imgW,maxColWidthPct,rowCount)};});
        sc.sort(function(a,b){return b.scoring.score-a.scoring.score;});
        var top=sc.slice(0,expCols);
        if(top.length<expCols||!top.every(function(s){return s.scoring.score>0;})){dbg.noScore++;continue;}

        if(rowCount) {
            var minRows = Math.max(rowCount - 4, Math.round(rowCount * 0.75));
            var rowsOK = top.every(function(s){
                return s.scoring.rowEstimate >= minRows;
            });
            if(!rowsOK){dbg.badRows++;continue;}
        }

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
        if(xSpread < imgW*0.15){dbg.tooNarrow++;continue;}

        var cs=top.reduce(function(s,t2){return s+t2.scoring.score;},0);
        var szs=top.map(function(s){return s.cluster.length;});
        cs*=(0.5+0.5*Math.min.apply(null,szs)/Math.max.apply(null,szs));
        if(rowCount) {
            var rowAccuracy = top.reduce(function(sum,s){
                return sum + Math.min(s.scoring.rowEstimate, rowCount) / rowCount;
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
// ROW BUILDING with cross-column validation
// =============================================================================
function anchorBuildRowsFromCluster(cluster, rowCount) {
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
    if (rows.length > rowCount) rows = rows.slice(0, rowCount);
    return rows;
}

// =============================================================================
// WARP: 4 anchor corners → perspective transform
// =============================================================================
function anchorComputeWarpCorners(colRows, rowCount, imgW, imgH, format) {
    var numCols = colRows.length;
    if (numCols < 2) return null;
    for (var ci=0;ci<numCols;ci++) if(colRows[ci].length<2) return null;

    var first = colRows[0], last = colRows[numCols-1];
    var r1=first[0], rN=first[first.length-1];
    var rLast1=last[0], rLastN=last[last.length-1];
    var sp1=(rN.y-r1.y)/(first.length-1);
    var sp2=(rLastN.y-rLast1.y)/(last.length-1);

    var groupSize = (format==='3col') ? 5.4 : 5.5;
    var totalUnits = (format==='3col') ? 16.2 : 11;

    var cx1_top=r1.x, cxLast_top=rLast1.x;
    var cx1_bot=rN.x, cxLast_bot=rLastN.x;
    var dist_top=(cxLast_top-cx1_top)/(numCols-1);
    var dist_bot=(cxLast_bot-cx1_bot)/(numCols-1);
    var n_top=dist_top/groupSize;
    var n_bot=dist_bot/groupSize;

    var rightExtend = (groupSize - 0.5);
    var leftX_top=cx1_top - n_top*0.5;
    var rightX_top=cxLast_top + rightExtend*n_top;
    var leftX_bot=cx1_bot - n_bot*0.5;
    var rightX_bot=cxLast_bot + rightExtend*n_bot;

    var padX_top=n_top*0.05, padX_bot=n_bot*0.05;
    var yPad1=sp1*0.55, yPad2=sp2*0.55;

    var TL={x:leftX_top-padX_top, y:r1.y-yPad1};
    var TR={x:rightX_top+padX_top, y:rLast1.y-yPad2};
    var BL={x:leftX_bot-padX_bot, y:rN.y+yPad1};
    var BR={x:rightX_bot+padX_bot, y:rLastN.y+yPad2};

    TL.x=Math.max(0,TL.x);TL.y=Math.max(0,TL.y);
    TR.x=Math.min(imgW-1,TR.x);TR.y=Math.max(0,TR.y);
    BL.x=Math.max(0,BL.x);BL.y=Math.min(imgH-1,BL.y);
    BR.x=Math.min(imgW-1,BR.x);BR.y=Math.min(imgH-1,BR.y);
    return {TL:TL,TR:TR,BL:BL,BR:BR};
}

function anchorPerspectiveWarp(srcMat, c) {
    var maxW=Math.round(Math.max(Math.sqrt(Math.pow(c.TR.x-c.TL.x,2)+Math.pow(c.TR.y-c.TL.y,2)),Math.sqrt(Math.pow(c.BR.x-c.BL.x,2)+Math.pow(c.BR.y-c.BL.y,2))));
    var maxH=Math.round(Math.max(Math.sqrt(Math.pow(c.TR.x-c.BR.x,2)+Math.pow(c.TR.y-c.BR.y,2)),Math.sqrt(Math.pow(c.TL.x-c.BL.x,2)+Math.pow(c.TL.y-c.BL.y,2))));
    var src=cv.matFromArray(4,1,cv.CV_32FC2,[c.TL.x,c.TL.y,c.TR.x,c.TR.y,c.BR.x,c.BR.y,c.BL.x,c.BL.y]);
    var dst=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,maxW-1,0,maxW-1,maxH-1,0,maxH-1]);
    var M=cv.getPerspectiveTransform(src,dst);var w=new cv.Mat();
    cv.warpPerspective(srcMat,w,M,new cv.Size(maxW,maxH));
    src.delete();dst.delete();M.delete();return w;
}

// =============================================================================
// COLUMN DETECTION on warped image
// =============================================================================
function anchorScoreColumnPattern(cols, config, gridWidth, balanceTol) {
    if (!balanceTol) balanceTol = 0.85;
    if (cols.length !== config.expectedCols) return Infinity;
    var gw = cols[cols.length-1].x - cols[0].x;
    if (gw < gridWidth * 0.60) return Infinity;

    var widths = [];
    for (var i = 0; i < cols.length - 1; i++)
        widths.push((cols[i+1].x - cols[i].x) / gw);

    var narrowIndices, wideIndices, pattern;
    if (config.format === '2col') {
        narrowIndices = [0, 3]; wideIndices = [1, 2, 4, 5];
        pattern = [1, 2.3, 2.2, 1, 2.3, 2.2];
    } else {
        narrowIndices = [0, 3, 6]; wideIndices = [1, 2, 4, 5, 7, 8];
        pattern = [1, 2.2, 2.2, 1, 2.2, 2.2, 1, 2.2, 2.2];
    }

    var narrowWidths = narrowIndices.map(function(i){return widths[i];});
    var wideWidths = wideIndices.map(function(i){return widths[i];});
    var narrowAvg = narrowWidths.reduce(function(a,b){return a+b;},0)/narrowWidths.length;
    var wideAvg = wideWidths.reduce(function(a,b){return a+b;},0)/wideWidths.length;

    var narrowRatio = Math.min(narrowWidths[0],narrowWidths[1])/Math.max(narrowWidths[0],narrowWidths[1]);
    if (narrowRatio < 0.60) return Infinity;
    if (config.format === '3col' && narrowWidths.length >= 3) {
        var n23ratio = Math.min(narrowWidths[1],narrowWidths[2])/Math.max(narrowWidths[1],narrowWidths[2]);
        if (n23ratio < 0.75) return Infinity;
    }

    var wideVar = Math.max.apply(null, wideWidths.map(function(w){return Math.abs(w-wideAvg);})) / wideAvg;
    if (wideVar > 0.25) return Infinity;

    var minWide = Math.min.apply(null, wideWidths);
    for (var ni = 0; ni < narrowWidths.length; ni++) {
        if (narrowWidths[ni] >= minWide) return Infinity;
    }

    if (config.format === '2col') {
        var leftHalfRatio = Math.min(widths[1],widths[2])/Math.max(widths[1],widths[2]);
        var rightHalfRatio = Math.min(widths[4],widths[5])/Math.max(widths[4],widths[5]);
        if (leftHalfRatio < balanceTol || rightHalfRatio < balanceTol) return Infinity;
        var leftWideAvg = (widths[1]+widths[2])/2;
        var rightWideAvg = (widths[4]+widths[5])/2;
        var crossHalfRatio = Math.min(leftWideAvg,rightWideAvg)/Math.max(leftWideAvg,rightWideAvg);
        if (crossHalfRatio < 0.90) return Infinity;
    } else if (config.format === '3col') {
        var secs = [[widths[1],widths[2]], [widths[4],widths[5]], [widths[7],widths[8]]];
        var secAvgs = secs.map(function(s){return (s[0]+s[1])/2;});
        for (var si3=0;si3<secs.length;si3++) {
            if (Math.min(secs[si3][0],secs[si3][1])/Math.max(secs[si3][0],secs[si3][1]) < balanceTol) return Infinity;
        }
        if (Math.min.apply(null,secAvgs)/Math.max.apply(null,secAvgs) < 0.85) return Infinity;
    }

    var ratio = narrowAvg / wideAvg;
    if (ratio > 0.60 || ratio < 0.15) return Infinity;

    var pSum = pattern.reduce(function(a,b){return a+b;},0);
    var pNorm = pattern.map(function(p){return p/pSum;});
    var err = 0;
    for (var j = 0; j < widths.length; j++)
        err += Math.pow(widths[j] - pNorm[j], 2);

    var coverage = gw / gridWidth;
    return err + Math.pow(1 - coverage, 2) * 0.05;
}

function anchorIsWideBalanced(boundaries, config, balanceTol) {
    if (!balanceTol) balanceTol = 0.85;
    if (!boundaries || boundaries.length < 7) return true;
    var gw = boundaries[boundaries.length-1] - boundaries[0];
    if (gw <= 0) return false;
    var widths = [];
    for (var i = 0; i < boundaries.length-1; i++)
        widths.push((boundaries[i+1] - boundaries[i]) / gw);

    if (config.format === '2col') {
        var leftRatio = Math.min(widths[1],widths[2]) / Math.max(widths[1],widths[2]);
        var rightRatio = Math.min(widths[4],widths[5]) / Math.max(widths[4],widths[5]);
        var leftAvg = (widths[1]+widths[2])/2, rightAvg = (widths[4]+widths[5])/2;
        var crossRatio = Math.min(leftAvg,rightAvg) / Math.max(leftAvg,rightAvg);
        return leftRatio > balanceTol && rightRatio > balanceTol && crossRatio > 0.90;
    } else if (config.format === '3col' && boundaries.length >= 10) {
        var secs = [[widths[1],widths[2]], [widths[4],widths[5]], [widths[7],widths[8]]];
        var avgs = secs.map(function(s){return (s[0]+s[1])/2;});
        for (var j=0;j<secs.length;j++) {
            if (Math.min(secs[j][0],secs[j][1])/Math.max(secs[j][0],secs[j][1]) < balanceTol) return false;
        }
        return Math.min.apply(null,avgs)/Math.max.apply(null,avgs) > 0.85;
    }
    return true;
}

function anchorDetectColumns(warpGray, format, log, expectedFracs) {
    var ww = warpGray.cols, wh = warpGray.rows;
    var config = format === '2col'
        ? {expectedCols:7, internalDividers:5, format:'2col'}
        : {expectedCols:10, internalDividers:8, format:'3col'};

    var expectedPos = expectedFracs
        ? expectedFracs.map(function(f){return Math.round(f*ww);})
        : null;
    if (expectedPos) {
        var expPcts = [];
        for (var ei = 0; ei < expectedPos.length-1; ei++)
            expPcts.push(Math.round((expectedPos[ei+1]-expectedPos[ei])/ww*100));
        log('  Expected from geometry: ['+expectedPos.join(', ')+'] → '+expPcts.join('% | ')+'%','dim');
    }

    log('  Warped: '+ww+'x'+wh+', looking for '+config.internalDividers+' internal dividers','dim');

    var sobelX = new cv.Mat();
    cv.Sobel(warpGray, sobelX, cv.CV_16S, 1, 0, 3);
    var absSobel = new cv.Mat();
    cv.convertScaleAbs(sobelX, absSobel);

    var colSums = new Array(ww).fill(0);
    for (var x = 0; x < ww; x++)
        for (var y = 0; y < wh; y++)
            colSums[x] += absSobel.ucharAt(y, x);

    var radius = 5;
    var smoothed = new Array(ww).fill(0);
    for (var x2 = radius; x2 < ww - radius; x2++) {
        var sum = 0;
        for (var dx = -radius; dx <= radius; dx++) sum += colSums[x2+dx];
        smoothed[x2] = sum / (radius*2+1);
    }

    var maxSum = Math.max.apply(null, smoothed);
    var edgeMargin = Math.round(ww * 0.01);
    var threshold = maxSum * 0.15;

    var allPeaks = [];
    for (var xp = edgeMargin; xp < ww - edgeMargin; xp++) {
        var isMax = true;
        for (var dxp = -10; dxp <= 10; dxp++) {
            if (dxp !== 0 && smoothed[xp+dxp] > smoothed[xp]) { isMax = false; break; }
        }
        if (isMax && smoothed[xp] > threshold) allPeaks.push({x:xp, score:smoothed[xp]});
    }

    var minGap = ww * 0.03;
    var clustered = [];
    allPeaks.sort(function(a,b){return a.x-b.x;});
    for (var pi = 0; pi < allPeaks.length; pi++) {
        var p = allPeaks[pi];
        if (clustered.length === 0 || p.x - clustered[clustered.length-1].x > minGap)
            clustered.push(p);
        else if (p.score > clustered[clustered.length-1].score)
            clustered[clustered.length-1] = p;
    }
    sobelX.delete(); absSobel.delete();
    log('  Sobel peaks: '+clustered.length+' at ['+clustered.map(function(c){return c.x;}).join(', ')+']','dim');

    // Inner helpers (kept nested as in testbed)
    function findBestColumnCombination(clusteredCols, config, gridWidth, leftEdge, rightEdge) {
        var bestCols = [], bestScore = Infinity;
        if (clusteredCols.length < config.internalDividers) return {cols:[], score:Infinity, valid:false};

        var candidates = clusteredCols.length <= 15
            ? clusteredCols
            : clusteredCols.slice().sort(function(a,b){return b.score-a.score;}).slice(0,12).sort(function(a,b){return a.x-b.x;});

        var combos = getCombosX(candidates, config.internalDividers);
        for (var ci = 0; ci < combos.length; ci++) {
            var cols = [{x:leftEdge}].concat(combos[ci]).concat([{x:rightEdge}]);
            var score = anchorScoreColumnPattern(cols, config, gridWidth);
            if (score < bestScore) { bestScore = score; bestCols = cols; }
        }
        return {cols:bestCols, score:bestScore, valid:bestScore < Infinity};
    }

    function getCombosX(a,k){
        if(a.length>15){var r=[];for(var s=0;s<=a.length-k;s++)r.push(a.slice(s,s+k));return r;}
        var res=[];
        function go(s,c){if(c.length===k){res.push(c.slice());return;}if(res.length>5000)return;
            for(var i=s;i<=a.length-(k-c.length);i++){c.push(a[i]);go(i+1,c);c.pop();}}
        go(0,[]);return res;
    }

    // === Strategy 1: Snap Sobel peaks to expected positions ===
    var savedSnapped = null;
    if (expectedPos && expectedPos.length === config.expectedCols) {
        var snapTolerance = ww * 0.05;

        var snapped = [expectedPos[0]];
        var allSnapped = true;
        for (var si = 1; si < expectedPos.length - 1; si++) {
            var target = expectedPos[si];
            var bestPeak = null, bestDist = Infinity;
            for (var pi3 = 0; pi3 < clustered.length; pi3++) {
                var d = Math.abs(clustered[pi3].x - target);
                if (d < bestDist) { bestDist = d; bestPeak = clustered[pi3]; }
            }
            if (bestPeak && bestDist < snapTolerance) {
                snapped.push(bestPeak.x);
            } else {
                snapped.push(target);
                if (bestDist >= snapTolerance) allSnapped = false;
            }
        }
        snapped.push(expectedPos[expectedPos.length-1]);
        log('  Snap result: ['+snapped.join(', ')+'] (widths: '+snapped.slice(0,-1).map(function(x,i){return snapped[i+1]-x;}).join(', ')+')','dim');
        savedSnapped = snapped.slice();

        var firstInternal = snapped[1];
        var lastInternal = snapped[snapped.length-2];

        log('  Left edge: fixed at '+snapped[0]+' (tight crop)','dim');

        var rightEdgePeaks = clustered.filter(function(c){return c.x > lastInternal + minGap*0.3 && c.x <= ww;});
        if (rightEdgePeaks.length > 0) {
            snapped[snapped.length-1] = rightEdgePeaks[rightEdgePeaks.length-1].x;
            log('  Snap R: peak@'+snapped[snapped.length-1]+' (was geom@'+expectedPos[expectedPos.length-1]+')','dim');
        }

        var snapCols = snapped.map(function(x3){return{x:x3};});
        var snapScore = anchorScoreColumnPattern(snapCols, config, ww);

        if (snapScore === Infinity || !anchorIsWideBalanced(snapped, config)) {
            log('  Initial snap '+(snapScore===Infinity?'invalid':'imbalanced')+', trying alt edges...','warn');
            var bestAltScore = snapScore === Infinity ? 999 : snapScore;
            var bestAltSnapped = snapped;

            var rightCands = clustered.filter(function(c){return c.x > lastInternal + minGap*0.3;});
            for (var rci = 0; rci < rightCands.length; rci++) {
                var alt = snapped.slice(0, -1).concat([rightCands[rci].x]);
                var altCols = alt.map(function(x4){return{x:x4};});
                var altScore = anchorScoreColumnPattern(altCols, config, ww);
                if (altScore < bestAltScore && anchorIsWideBalanced(alt, config)) {
                    bestAltScore = altScore; bestAltSnapped = alt;
                    log('  → Better R='+rightCands[rci].x+' (score='+altScore.toFixed(4)+')','dim');
                }
            }
            var leftCands = clustered.filter(function(c){return c.x < firstInternal * 0.5;});
            leftCands = [].concat([{x:0}], leftCands);
            for (var lci = 0; lci < leftCands.length; lci++) {
                var altL = [leftCands[lci].x].concat(snapped.slice(1));
                var altLCols = altL.map(function(x5){return{x:x5};});
                var altLScore = anchorScoreColumnPattern(altLCols, config, ww);
                if (altLScore < bestAltScore && anchorIsWideBalanced(altL, config)) {
                    bestAltScore = altLScore; bestAltSnapped = altL;
                    log('  → Better L='+leftCands[lci].x+' (score='+altLScore.toFixed(4)+')','dim');
                }
            }
            snapped = bestAltSnapped;
            snapScore = bestAltScore >= 999 ? Infinity : bestAltScore;
            snapCols = snapped.map(function(x6){return{x:x6};});
        }

        if (snapScore < Infinity) {
            var snapGw = snapped[snapped.length-1]-snapped[0];
            var snapPcts = [];
            for (var swi = 0; swi < snapped.length-1; swi++)
                snapPcts.push(Math.round((snapped[swi+1]-snapped[swi])/snapGw*100));
            var labels = format==='2col'?['n','W','W','n','W','W']:['n','W','W','n','W','W','n','W','W'];
            log('  ✓ Geometry-snapped (score='+snapScore.toFixed(4)+(allSnapped?', all peaks found':'')+'):'
                +' '+snapPcts.map(function(w2,i){return labels[i]+'='+w2+'%';}).join(' | '),'good');
            log('  Grid: '+snapped[0]+'..'+snapped[snapped.length-1]
                +' ('+Math.round(snapGw/ww*100)+'%'
                +(ww-snapped[snapped.length-1]>1?' R-margin:'+(ww-snapped[snapped.length-1])+'px('+Math.round((ww-snapped[snapped.length-1])/ww*100)+'%)':'')
                +')','dim');
            return {boundaries:snapped, score:snapScore, method:'geometry-snapped'};
        }
        log('  Geometry snap failed — falling through to full combo search','warn');
    }

    // === Strategy 2: Edge hypotheses ===
    var edgeHypotheses = [{left:0, right:ww, name:'0/ww'}];
    if (clustered.length >= 2) {
        var lastPeak = clustered[clustered.length-1].x;
        if (lastPeak > ww*0.75)
            edgeHypotheses.push({left:0, right:lastPeak, name:'0/lastPeak'});
        var nearRight = clustered.filter(function(c){return c.x > ww*0.75;});
        for (var ri = 0; ri < nearRight.length; ri++) {
            if (!edgeHypotheses.some(function(h){return h.right===nearRight[ri].x;}))
                edgeHypotheses.push({left:0, right:nearRight[ri].x, name:'0/peak@'+nearRight[ri].x});
        }
    }

    var bestResult = null, bestScore = Infinity, bestEdge = '';
    var peakXSet = {};
    clustered.forEach(function(c){peakXSet[c.x]=true;});

    for (var ehi = 0; ehi < edgeHypotheses.length; ehi++) {
        var eh = edgeHypotheses[ehi];
        var interior = clustered.filter(function(c){return c.x > eh.left + minGap*0.5 && c.x < eh.right - minGap*0.5;});
        if (interior.length < config.internalDividers) continue;
        var result = findBestColumnCombination(interior, config, eh.right-eh.left, eh.left, eh.right);
        if (result.valid) {
            var adjustedScore = result.score;
            if (!peakXSet[eh.right]) {
                adjustedScore += 0.002;
            }
            log('    Hyp ['+eh.name+']: raw='+result.score.toFixed(4)+(peakXSet[eh.right]?'':' +0.002 no-peak')+'='+adjustedScore.toFixed(4),'dim');
            if (adjustedScore < bestScore) {
                bestScore = adjustedScore;
                bestResult = result;
                bestEdge = eh.name;
            }
        }
    }

    if (bestResult && bestResult.valid) {
        var boundaries = bestResult.cols.map(function(c){return c.x;});
        var gw = boundaries[boundaries.length-1] - boundaries[0];
        var widthPcts = [];
        for (var wi = 0; wi < boundaries.length-1; wi++)
            widthPcts.push(Math.round((boundaries[wi+1]-boundaries[wi])/gw*100));
        var labels2 = format==='2col'?['n','W','W','n','W','W']:['n','W','W','n','W','W','n','W','W'];
        log('  ✓ Edge-hypothesis ['+bestEdge+'] (score='+bestScore.toFixed(4)+'): '+widthPcts.map(function(w2,i){return labels2[i]+'='+w2+'%';}).join(' | '),'good');
        log('  Grid: '+boundaries[0]+'..'+boundaries[boundaries.length-1]
            +' ('+Math.round(gw/ww*100)+'%'
            +(ww-boundaries[boundaries.length-1]>1?' R-margin:'+(ww-boundaries[boundaries.length-1])+'px('+Math.round((ww-boundaries[boundaries.length-1])/ww*100)+'%)':'')
            +')','dim');
        return {boundaries:boundaries, score:bestScore, method:'detected ['+bestEdge+']'};
    }

    // === Strategy 3: Hybrid fallback ===
    if (expectedPos) {
        var hybridPos = null;
        if (savedSnapped && savedSnapped.length === config.expectedCols) {
            hybridPos = [expectedPos[0]].concat(savedSnapped.slice(1, -1)).concat([expectedPos[expectedPos.length-1]]);
            var hybridCols = hybridPos.map(function(x8){return{x:x8};});
            var hybridScore = anchorScoreColumnPattern(hybridCols, config, ww, 0.80);
            if (hybridScore < Infinity) {
                var hybridGw = hybridPos[hybridPos.length-1]-hybridPos[0];
                var hybridPcts = [];
                for (var hi = 0; hi < hybridPos.length-1; hi++)
                    hybridPcts.push(Math.round((hybridPos[hi+1]-hybridPos[hi])/hybridGw*100));
                var labels3 = format==='2col'?['n','W','W','n','W','W']:['n','W','W','n','W','W','n','W','W'];
                log('  ✓ Hybrid fallback (snapped internals + geom edges, score='+hybridScore.toFixed(4)+'): '
                    +hybridPcts.map(function(w3,i){return labels3[i]+'='+w3+'%';}).join(' | '),'good');
                return {boundaries:hybridPos, score:hybridScore, method:'hybrid-fallback'};
            }
            log('  Hybrid fallback invalid — using pure geometry','dim');
        }
        log('  Using geometry positions as fallback','warn');
        return {boundaries:expectedPos, score:0.5, method:'geometry-fallback'};
    }

    log('  ✗ All detection failed, using proportional widths','err');
    var props = format==='2col'?[0,0.08,0.29,0.50,0.58,0.79,1.0]:[0,0.055,0.195,0.335,0.39,0.53,0.67,0.725,0.865,1.0];
    return {boundaries:props.map(function(r){return Math.round(r*ww);}), score:1, method:'proportional'};
}

// =============================================================================
// ROW DETECTION on warped image
// =============================================================================
function anchorDetectRows(warpGray, colB, rowCount, log, format) {
    var ww=warpGray.cols,wh=warpGray.rows;
    var needed = rowCount + 1;
    var sy=new cv.Mat();cv.Sobel(warpGray,sy,cv.CV_16S,0,1,3);var ay=new cv.Mat();cv.convertScaleAbs(sy,ay);

    var numSections = (format==='3col') ? 3 : 2;
    var sectionBounds = [colB[0]];
    if(format==='3col') {
        if(colB.length>4) sectionBounds.push(Math.round((colB[3]+colB[4])/2));
        if(colB.length>7) sectionBounds.push(Math.round((colB[6]+colB[7])/2));
    } else {
        if(colB.length>4) sectionBounds.push(Math.round((colB[3]+colB[4])/2));
    }
    sectionBounds.push(colB[colB.length-1]);
    var lw = Math.max(5, Math.round(ww*0.008));

    var numColPairs = [[0,1]];
    if(colB.length>4) numColPairs.push([3,4]);
    if(format==='3col' && colB.length>7) numColPairs.push([6,7]);

    function scanSection(startX, endX, sectionIdx, label) {
        var numColCenters = [];
        var pair = numColPairs[sectionIdx];
        if(pair && pair[1]<colB.length) {
            var nc = Math.round((colB[pair[0]]+colB[pair[1]])/2);
            if(nc >= startX && nc <= endX) numColCenters.push(nc);
        }
        var internalCols = colB.filter(function(x){return x > startX + lw && x < endX - lw;});
        var scanPositions = numColCenters.concat(internalCols);
        if(scanPositions.length === 0) scanPositions = [Math.round((startX + endX) / 2)];

        var numColW = Math.max(3, Math.round(ww*0.015));
        var prof = new Array(wh).fill(0);
        for(var y=0;y<wh;y++) {
            for(var di=0;di<scanPositions.length;di++) {
                var vx=scanPositions[di];
                var scanW = (di < numColCenters.length) ? numColW : lw;
                for(var x=Math.max(0,vx-scanW);x<=Math.min(ww-1,vx+scanW);x++) prof[y]+=ay.ucharAt(y,x);
            }
        }
        var sm=[];for(var i=0;i<wh;i++){var s=0,c=0;for(var j=Math.max(0,i-2);j<=Math.min(wh-1,i+2);j++){s+=prof[j];c++;}sm.push(s/c);}
        var mx=Math.max.apply(null,sm),thr=mx*0.2,expH=wh/(rowCount+1),minD=Math.round(expH*0.4),peaks=[];
        for(var pi=1;pi<sm.length-1;pi++){if(sm[pi]>=thr&&sm[pi]>=sm[pi-1]&&sm[pi]>=sm[pi+1]){
            if(!peaks.length||pi-peaks[peaks.length-1].pos>=minD)peaks.push({pos:pi,val:sm[pi]});
            else if(sm[pi]>peaks[peaks.length-1].val)peaks[peaks.length-1]={pos:pi,val:sm[pi]};}}
        log('  '+label+': '+peaks.length+' H-line candidates (need '+needed+')','dim');
        return peaks;
    }

    var sectionLabels = numSections===3 ? ['Left','Middle','Right'] : ['Left','Right'];
    var sectionPeaks = [];
    for(var si=0;si<numSections;si++){
        sectionPeaks.push(scanSection(sectionBounds[si], sectionBounds[si+1], si, sectionLabels[si]));
    }

    // selectBestRows — nested as in testbed
    function selectBestRows(peaks) {
        if(peaks.length === needed) return peaks.map(function(p){return p.pos;});
        if(peaks.length > needed) {
            var expH2=wh/(rowCount+1);

            if(peaks.length <= needed + 3) {
                var interior = peaks.slice(1, -1);
                interior.sort(function(a,b){return a.val-b.val;});
                var toDrop = peaks.length - needed;
                var dropSet = {};
                for(var di=0; di<toDrop && di<interior.length; di++) {
                    for(var fi=1; fi<peaks.length-1; fi++) {
                        if(peaks[fi]===interior[di]) { dropSet[fi]=true; break; }
                    }
                }
                var kept = [];
                for(var ki=0; ki<peaks.length; ki++) {
                    if(!dropSet[ki]) kept.push(peaks[ki]);
                }
                if(kept.length === needed) {
                    var sps0=[];for(var k0=1;k0<kept.length;k0++)sps0.push(kept[k0].pos-kept[k0-1].pos);
                    var mn0=sps0.reduce(function(a,b){return a+b;},0)/sps0.length;
                    var maxDev0=Math.max.apply(null,sps0.map(function(s){return Math.abs(s-mn0);}));
                    if(maxDev0 < mn0*0.5) {
                        return kept.map(function(p){return p.pos;});
                    }
                }
            }

            var bestSet=null, bestVar=Infinity;
            var si0=0, ei0=peaks.length-1;
            var spanH = peaks[ei0].pos - peaks[si0].pos;
            var rowH = spanH / (needed - 1);
            var minSelGap = rowH * 0.6;
            if(rowH >= expH2*0.5 && rowH <= expH2*1.6) {
                var sel = [peaks[si0]], used = {}; used[si0]=true;
                var ok = true;
                for(var ri=1;ri<needed-1;ri++){
                    var target = peaks[si0].pos + ri*rowH;
                    var bestPi=-1, bestDist=Infinity;
                    for(var pi2=1;pi2<peaks.length-1;pi2++){
                        if(used[pi2])continue;
                        if(peaks[pi2].pos - sel[sel.length-1].pos < minSelGap) continue;
                        var d=Math.abs(peaks[pi2].pos-target);
                        if(d<bestDist){bestDist=d;bestPi=pi2;}
                    }
                    if(bestPi<0||bestDist>rowH*0.4){ok=false;break;}
                    sel.push(peaks[bestPi]);used[bestPi]=true;
                }
                if(ok) {
                    sel.push(peaks[ei0]);
                    sel.sort(function(a,b){return a.pos-b.pos;});
                    if(sel.length===needed) {
                        var sps1=[];for(var k1=1;k1<sel.length;k1++)sps1.push(sel[k1].pos-sel[k1-1].pos);
                        var mn1=sps1.reduce(function(a,b){return a+b;},0)/sps1.length;
                        var v1=sps1.reduce(function(s,v2){return s+Math.pow(v2-mn1,2);},0)/sps1.length;
                        if(v1<bestVar){bestVar=v1;bestSet=sel;}
                    }
                }
            }

            for(var si=0; si<Math.min(peaks.length,3); si++) {
                for(var ei=peaks.length-1; ei>=Math.max(si+needed-2, peaks.length-3); ei--) {
                    var spanH2 = peaks[ei].pos - peaks[si].pos;
                    var rowH2 = spanH2 / (needed - 1);
                    if(rowH2 < expH2*0.5 || rowH2 > expH2*1.6) continue;
                    var minSelGap2 = rowH2 * 0.6;
                    var sel2 = [peaks[si]], used2 = {}; used2[si]=true; var ok2=true;
                    for(var ri2=1;ri2<needed;ri2++){
                        var target2 = peaks[si].pos + ri2*rowH2;
                        var bestPi2=-1, bestDist2=Infinity;
                        for(var pi3=0;pi3<peaks.length;pi3++){
                            if(used2[pi3])continue;
                            if(peaks[pi3].pos - sel2[sel2.length-1].pos < minSelGap2) continue;
                            var d2=Math.abs(peaks[pi3].pos-target2);
                            if(d2<bestDist2){bestDist2=d2;bestPi2=pi3;}
                        }
                        if(bestPi2<0||bestDist2>rowH2*0.4){ok2=false;break;}
                        sel2.push(peaks[bestPi2]);used2[bestPi2]=true;
                    }
                    if(!ok2||sel2.length!==needed)continue;
                    sel2.sort(function(a,b){return a.pos-b.pos;});
                    var sps2=[];for(var k2=1;k2<sel2.length;k2++)sps2.push(sel2[k2].pos-sel2[k2-1].pos);
                    var mn2=sps2.reduce(function(a,b){return a+b;},0)/sps2.length;
                    var v2=sps2.reduce(function(s,vv){return s+Math.pow(vv-mn2,2);},0)/sps2.length;
                    if(v2<bestVar){bestVar=v2;bestSet=sel2;}
                }
            }
            if(bestSet) return bestSet.map(function(p){return p.pos;});

            var byStr=peaks.slice(1,-1).sort(function(a,b){return b.val-a.val;}).slice(0,needed-2);
            byStr.push(peaks[0]);byStr.push(peaks[peaks.length-1]);
            byStr.sort(function(a,b){return a.pos-b.pos;});
            return byStr.map(function(p){return p.pos;});
        }
        if(peaks.length >= needed - 4) {
            var result=peaks.map(function(p){return p.pos;});
            var gaps=[];for(var g=1;g<result.length;g++)gaps.push(result[g]-result[g-1]);
            var medG=gaps.slice().sort(function(a,b){return a-b;})[Math.floor(gaps.length/2)];
            var filled=[result[0]];
            for(var gi=1;gi<result.length;gi++){
                var gap2=result[gi]-filled[filled.length-1];
                if(gap2>medG*1.6&&gap2<medG*2.5)filled.push(Math.round(filled[filled.length-1]+gap2/2));
                filled.push(result[gi]);
            }
            while(filled.length<needed&&filled[0]-medG>0)filled.unshift(Math.round(filled[0]-medG));
            while(filled.length<needed)filled.push(Math.round(filled[filled.length-1]+medG));
            if(filled.length>needed)filled=filled.slice(0,needed);
            return filled;
        }
        return null;
    }

    // fixBoundaries — nested as in testbed
    function fixBoundaries(rows) {
        if(!rows || rows.length < 3) return rows;
        var sps=[];for(var i=1;i<rows.length;i++)sps.push(rows[i]-rows[i-1]);
        var med=sps.slice().sort(function(a,b){return a-b;})[Math.floor(sps.length/2)];

        if(rows[0] > med*0.6) {
            var topY = Math.max(0, rows[0] - med);
            rows.unshift(topY);
            log('  ↑ Added top boundary at y='+topY+' (first peak was at '+rows[1]+', gap='+Math.round(rows[1]-topY)+')','dim');
        }
        if(wh - rows[rows.length-1] > med*0.6) {
            var botY = Math.min(wh-1, rows[rows.length-1] + med);
            rows.push(botY);
            log('  ↓ Added bottom boundary at y='+botY+' (last peak was at '+rows[rows.length-2]+', gap='+Math.round(botY-rows[rows.length-2])+')','dim');
        }
        while(rows.length > needed) {
            var minGapIdx=1, minGapVal=Infinity;
            for(var gi=1;gi<rows.length-1;gi++) {
                var g=Math.min(rows[gi]-rows[gi-1], rows[gi+1]-rows[gi]);
                if(g<minGapVal){minGapVal=g;minGapIdx=gi;}
            }
            rows.splice(minGapIdx,1);
        }
        return rows;
    }

    // enforceConsistency — nested as in testbed
    function enforceConsistency(rows, label) {
        if(!rows || rows.length < 5) return rows;
        var sps=[];for(var i=1;i<rows.length;i++)sps.push(rows[i]-rows[i-1]);
        var sorted=sps.slice().sort(function(a,b){return a-b;});
        var med=sorted[Math.floor(sorted.length/2)];
        var spStrs=[];
        var outlierCount=0;
        for(var si=0;si<sps.length;si++){
            var ratio=sps[si]/med;
            var mark='';
            if(ratio<0.7||ratio>1.4){mark=' ⚠';outlierCount++;}
            spStrs.push(Math.round(sps[si])+(si<rows.length-2?'':'')+ mark);
        }
        log('  '+label+' final spacings: ['+spStrs.join(', ')+'] med='+Math.round(med)
            +(outlierCount>0?' ('+outlierCount+' outliers)':''),'dim');

        var minSp = Math.min.apply(null, sps), maxSp = Math.max.apply(null, sps);
        var spRatio = maxSp / Math.max(1, minSp);
        if(outlierCount > sps.length * 0.2) {
            log('  '+label+' → equal subdivision (outliers='+outlierCount+'/'+sps.length+')','warn');
            var eqRows = [];
            var eqStep = wh / (rows.length - 1);
            for(var ei=0;ei<rows.length;ei++) eqRows.push(Math.round(ei * eqStep));
            var eqSps = [];
            for(var ej=1;ej<eqRows.length;ej++) eqSps.push(Math.round(eqRows[ej]-eqRows[ej-1]));
            log('  '+label+' EQUAL spacings: ['+eqSps.join(', ')+'] step='+Math.round(eqStep),'dim');
            return eqRows;
        }

        if(outlierCount > 0 && outlierCount <= 6) {
            for(var oi=0;oi<sps.length-1;oi++){
                var r1x=sps[oi]/med, r2x=sps[oi+1]/med;
                if(r1x>1.3 && r2x<0.7 && oi+1>0 && oi+1<rows.length-1) {
                    var idealY = Math.round(rows[oi] + med);
                    log('    Fix pair['+oi+','+(oi+1)+']: row['+(oi+1)+'] '+rows[oi+1]+' → '+idealY
                        +' (gaps '+Math.round(sps[oi])+'+'+Math.round(sps[oi+1])+'='+Math.round(sps[oi]+sps[oi+1])+', med='+Math.round(med)+')','warn');
                    rows[oi+1] = idealY;
                    sps=[];for(var i2b=1;i2b<rows.length;i2b++)sps.push(rows[i2b]-rows[i2b-1]);
                    oi++;
                } else if(r1x<0.7 && r2x>1.3 && oi>0 && oi+1<rows.length-1) {
                    var idealY2 = Math.round(rows[oi+2] - med);
                    log('    Fix pair['+oi+','+(oi+1)+']: row['+(oi+1)+'] '+rows[oi+1]+' → '+idealY2
                        +' (gaps '+Math.round(sps[oi])+'+'+Math.round(sps[oi+1])+', med='+Math.round(med)+')','warn');
                    rows[oi+1] = idealY2;
                    sps=[];for(var i2c=1;i2c<rows.length;i2c++)sps.push(rows[i2c]-rows[i2c-1]);
                    oi++;
                }
            }
            sps=[];for(var i2r=1;i2r<rows.length;i2r++)sps.push(rows[i2r]-rows[i2r-1]);
            sorted=sps.slice().sort(function(a,b){return a-b;});
            med=sorted[Math.floor(sorted.length/2)];
            minSp=Math.min.apply(null,sps); maxSp=Math.max.apply(null,sps);
            spRatio=maxSp/Math.max(1,minSp);
            outlierCount=0;
            for(var si2=0;si2<sps.length;si2++){
                var ratio2=sps[si2]/med;
                if(ratio2<0.7||ratio2>1.4) outlierCount++;
            }
        }

        if(spRatio > 1.5) {
            log('  '+label+' → equal subdivision (max/min='+Math.round(maxSp)+'/'+Math.round(minSp)+'='+spRatio.toFixed(2)+', outliers='+outlierCount+')','warn');
            var eqRows2 = [];
            var eqStep2 = wh / (rows.length - 1);
            for(var ei2=0;ei2<rows.length;ei2++) eqRows2.push(Math.round(ei2 * eqStep2));
            var eqSps2 = [];
            for(var ej2=1;ej2<eqRows2.length;ej2++) eqSps2.push(Math.round(eqRows2[ej2]-eqRows2[ej2-1]));
            log('  '+label+' EQUAL spacings: ['+eqSps2.join(', ')+'] step='+Math.round(eqStep2),'dim');
            return eqRows2;
        }

        var lastGap = rows[rows.length-1] - rows[rows.length-2];
        if(lastGap < med*0.75) {
            var newLast = Math.min(wh-1, rows[rows.length-2] + med);
            log('    Fix last: row['+(rows.length-1)+'] '+rows[rows.length-1]+' → '+newLast+' (gap was '+Math.round(lastGap)+' < 0.75×med='+Math.round(med*0.75)+')','warn');
            rows[rows.length-1] = newLast;
        }
        var firstGap = rows[1] - rows[0];
        if(firstGap < med*0.75 && rows[0] > med*0.3) {
            var newFirst = Math.max(0, rows[1] - med);
            log('    Fix first: row[0] '+rows[0]+' → '+newFirst+' (gap was '+Math.round(firstGap)+' < 0.75×med='+Math.round(med*0.75)+')','warn');
            rows[0] = newFirst;
        }

        sps=[];for(var i2d=1;i2d<rows.length;i2d++)sps.push(rows[i2d]-rows[i2d-1]);
        for(var oi2=1;oi2<sps.length-1;oi2++){
            var rx=sps[oi2]/med;
            if(rx>1.4) {
                var nY=Math.round(rows[oi2]+med);
                if(Math.abs(nY-rows[oi2+1])>med*0.25){
                    log('    Fix solo: row['+(oi2+1)+'] '+rows[oi2+1]+' → '+nY+' (gap='+Math.round(sps[oi2])+')','warn');
                    rows[oi2+1]=nY;
                    sps=[];for(var i2e=1;i2e<rows.length;i2e++)sps.push(rows[i2e]-rows[i2e-1]);
                }
            }
        }

        rows.sort(function(a,b){return a-b;});
        sps=[];for(var i3=1;i3<rows.length;i3++)sps.push(rows[i3]-rows[i3-1]);
        log('  '+label+' FIXED spacings: ['+sps.map(function(s){return Math.round(s);}).join(', ')+']','dim');
        return rows;
    }

    var sectionRows = [];
    for(var sri=0;sri<sectionPeaks.length;sri++){
        sectionRows.push(fixBoundaries(selectBestRows(sectionPeaks[sri])));
    }
    sy.delete();ay.delete();

    for(var eri=0;eri<sectionRows.length;eri++){
        sectionRows[eri] = enforceConsistency(sectionRows[eri], sectionLabels[eri]);
    }

    var allGood = sectionRows.every(function(r){return r && r.length>0;});
    if(allGood) {
        log('  Rows: '+sectionRows.map(function(r,i){return sectionLabels[i]+'='+r.length+' lines ('+(r.length-1)+' rows)';}).join(', ')+(sectionRows.length>1?' (independent)':''),'good');
        return {sections: sectionRows, sectionBounds: sectionBounds, independent: sectionRows.length>1, left: sectionRows[0], right: sectionRows[sectionRows.length-1]};
    }
    var bestSec = null;
    for(var fbi=0;fbi<sectionRows.length;fbi++){if(sectionRows[fbi] && sectionRows[fbi].length>0){bestSec=sectionRows[fbi];break;}}
    if(bestSec) {
        var fallSecs=[];for(var fsi=0;fsi<numSections;fsi++)fallSecs.push(bestSec);
        return {sections:fallSecs, sectionBounds:sectionBounds, independent:false, left:bestSec, right:bestSec};
    }
    var uniform=[];for(var uri=0;uri<=rowCount;uri++)uniform.push(Math.round(wh*uri/rowCount));
    var uniSecs=[];for(var usi=0;usi<numSections;usi++)uniSecs.push(uniform);
    return {sections:uniSecs, sectionBounds:sectionBounds, independent:false, left:uniform, right:uniform};
}

// =============================================================================
// CELL EXTRACTION from warped image
// =============================================================================
function anchorExtractCells(warped, colB, rowL, startNums, rowCount, format) {
    var cells=[],maps=format==='2col'?[[1,'w',0],[2,'b',0],[4,'w',rowCount],[5,'b',rowCount]]
        :[[1,'w',0],[2,'b',0],[4,'w',rowCount],[5,'b',rowCount],[7,'w',rowCount*2],[8,'b',rowCount*2]];
    var xP=4,yP=2,descenderExtra=15;
    var sections = rowL.sections || [rowL.left, rowL.right];
    function getSection(ci) { return sections[Math.min(Math.floor(ci/3), sections.length-1)]; }

    var minLen = Math.min.apply(null, sections.map(function(s){return s?s.length:0;}));
    for(var ri=0;ri<minLen-1;ri++){
        for(var mi=0;mi<maps.length;mi++){var ci=maps[mi][0],co=maps[mi][1],off=maps[mi][2];
            if(ci+1>=colB.length)continue;
            var rows = getSection(ci);
            if(!rows || ri+1>=rows.length) continue;
            var y1=rows[ri]+yP, y2=Math.min(rows[ri+1]+descenderExtra, warped.rows);
            if(y2<=y1+3)continue;
            var x1=colB[ci]+xP,x2=colB[ci+1]-xP;if(x2<=x1+3)continue;
            var mn=ri+1+off;if(mn>rowCount*(format==='3col'?3:2))continue;
            try{var rc=new cv.Rect(Math.max(0,x1),Math.max(0,y1),Math.min(x2-x1,warped.cols-x1),Math.min(y2-y1,warped.rows-y1));
                if(rc.width>5&&rc.height>5)cells.push({moveNumber:mn,color:co,bbox:{x:x1,y:y1,width:rc.width,height:rc.height},image:warped.roi(rc).clone()});}catch(e){}}}
    cells.sort(function(a,b){return a.moveNumber!==b.moveNumber?a.moveNumber-b.moveNumber:(a.color==='w'?-1:1);});return cells;
}

// =============================================================================
// AUTO FIND — 4-phase auto-calibration
// =============================================================================
function anchorAutoFind(srcGray, config, log) {
    var format = config.format || '2col';
    var expCols = format==='3col' ? 3 : 2;
    var maxWP = config.maxColWidthPct || 7;
    var rowCount = config.rowCount || 20;
    var curMinH = config.minDigitH || 0.8;
    var maxHR = (config.maxDigitH || 4.0) / 100;
    var maxWR = (config.maxDigitW || 2.5) / 100;
    var blockPct = config.blockSize || 2.0;
    var curXW = config.xWeight || 4;

    log('\n=== AUTO FIND (v9l) ===','phase');

    function getMinXTight(result) {
        if(!result.details) return 0;
        return Math.min.apply(null, result.details.map(function(d){return d.scoring.xTight||0;}));
    }
    function getMinRowEst(result) {
        if(!result.details) return 0;
        return Math.min.apply(null, result.details.map(function(d){return d.scoring.rowEstimate||0;}));
    }

    function tryCombination(minHR, xW, tryMaxWR) {
        var useMaxWR = tryMaxWR || maxWR;
        var cands=anchorFindCandidates(srcGray,{minHR:minHR,maxHR:maxHR,maxWR:useMaxWR,blockPct:blockPct},log);
        cands.cleaned.delete();
        var cl=anchorSingleLinkage(cands.cands,xW);
        var result=anchorAutoFindBestCut(cands.cands,cl.edges,srcGray.rows,srcGray.cols,expCols,maxWP,rowCount,log);
        result.minXT=getMinXTight(result);
        result.minRowEst=getMinRowEst(result);
        return{result:result, cands:cands, cl:cl, minH:minHR*100, xW:xW, maxWR:useMaxWR};
    }

    // === Phase 1: Try with current settings ===
    var initTrial = tryCombination(curMinH/100, curXW);
    var initResult = initTrial.result;
    log('  Initial (minH='+curMinH+'% xW='+curXW+'): score='+initResult.bestScore.toFixed(2)
        +' minXTight='+initResult.minXT.toFixed(2)+' ~'+initResult.minRowEst+'rows at '+initResult.bestN+' clusters','dim');
    var bestResult=initResult, bestMinH=curMinH, bestXW=curXW, bestMaxW=maxWR*100;
    var bestTrial = initTrial;

    // === Phase 2: If x-tightness is low, retry with lower minH% ===
    if(bestResult.minXT < 0.9 && bestResult.bestScore > 0) {
        var minHSteps=[0.6, 0.4];
        for(var ri=0;ri<minHSteps.length;ri++){
            if(minHSteps[ri] >= curMinH) continue;
            log('  Retry minH='+minHSteps[ri]+'% (xTight='+bestResult.minXT.toFixed(2)+' < 0.9)...','dim');
            var trial=tryCombination(minHSteps[ri]/100, curXW);
            log('    → score='+trial.result.bestScore.toFixed(2)+' xTight='+trial.result.minXT.toFixed(2),'dim');
            if(trial.result.minXT > bestResult.minXT + 0.05) {
                bestResult=trial.result; bestMinH=minHSteps[ri]; bestXW=curXW;
                bestTrial.cands.binary.delete();
                bestTrial = trial;
            } else { trial.cands.binary.delete(); }
            if(bestResult.minXT >= 0.95) break;
        }
    }

    // === Phase 3: If clustering failed, retry with higher xWeight ===
    if(bestResult.bestScore < 0) {
        var xwSteps=[6, 8, 10];
        var minHToTry=[curMinH, 0.6, 0.4];
        log('  Clustering failed — retrying with higher xWeight...','warn');

        for(var xi=0;xi<xwSteps.length && bestResult.bestScore<0;xi++){
            if(xwSteps[xi] <= curXW) continue;
            for(var mi=0;mi<minHToTry.length;mi++){
                var tryMinH=minHToTry[mi]/100;
                log('  Retry xW='+xwSteps[xi]+' minH='+(tryMinH*100).toFixed(1)+'%...','dim');
                var trial2=tryCombination(tryMinH, xwSteps[xi]);
                log('    → score='+trial2.result.bestScore.toFixed(2)+' xTight='+trial2.result.minXT.toFixed(2)
                    +' ('+trial2.cands.cands.length+' cands)','dim');
                if(trial2.result.bestScore > 0 && trial2.result.minXT > bestResult.minXT) {
                    bestResult=trial2.result; bestMinH=tryMinH*100; bestXW=xwSteps[xi];
                    bestTrial.cands.binary.delete();
                    bestTrial = trial2;
                    if(bestResult.minXT >= 0.95) break;
                } else { trial2.cands.binary.delete(); }
            }
        }
    }

    // === Phase 4: If columns estimate too few rows, retry with higher Max W% ===
    if(bestResult.bestScore > 0 && bestResult.minRowEst < rowCount - 1) {
        var maxWSteps = [3.5, 4.5];
        log('  Columns estimate ~'+bestResult.minRowEst+' rows (need '+rowCount+') — retrying with higher maxW%...','warn');

        for(var wi=0;wi<maxWSteps.length;wi++){
            if(maxWSteps[wi] <= bestMaxW) continue;
            var tryMaxWR = maxWSteps[wi] / 100;
            log('  Retry maxW='+maxWSteps[wi]+'%...','dim');
            var trial4 = tryCombination(bestMinH/100, bestXW, tryMaxWR);
            log('    → score='+trial4.result.bestScore.toFixed(2)+' ~'+trial4.result.minRowEst+'rows'
                +' xTight='+trial4.result.minXT.toFixed(2)+' ('+trial4.cands.cands.length+' cands)','dim');
            if(trial4.result.bestScore > 0 && trial4.result.minRowEst > bestResult.minRowEst
               && trial4.result.minXT >= 0.9) {
                bestResult = trial4.result; bestMaxW = maxWSteps[wi];
                bestTrial.cands.binary.delete();
                bestTrial = trial4;
                if(bestResult.minRowEst >= rowCount) break;
            } else { trial4.cands.binary.delete(); }
        }
    }

    // Cleanup binary from best trial
    bestTrial.cands.binary.delete();

    var changes=[];
    if(bestMinH !== curMinH) changes.push('minH%: '+curMinH+' → '+bestMinH);
    if(bestXW !== curXW) changes.push('xWeight: '+curXW+' → '+bestXW);
    if(bestMaxW !== maxWR*100) changes.push('maxW%: '+(maxWR*100)+' → '+bestMaxW);
    if(changes.length > 0) log('  ★ Auto-calibrated: '+changes.join(', '),'good');

    log('Best cut: '+bestResult.bestN+' clusters (score='+bestResult.bestScore.toFixed(2)
        +', minXTight='+(bestResult.minXT||0).toFixed(2)+')','good');

    return {
        bestResult: bestResult,
        bestN: bestResult.bestN,
        bestMinH: bestMinH,
        bestXW: bestXW,
        bestMaxW: bestMaxW,
        config: { minDigitH: bestMinH, maxDigitH: maxHR*100, maxDigitW: bestMaxW, blockSize: blockPct, xWeight: bestXW, maxColWidthPct: maxWP }
    };
}

// =============================================================================
// RUN PIPELINE — full detection on already-cropped image
// =============================================================================
function anchorRunPipeline(srcMat, srcGray, config, log) {
    var format = config.format || '2col';
    var rowCount = config.rowCount || 20;
    var numClusters = config.numClusters;
    var maxWP = config.maxColWidthPct || 7;
    var expCols = format==='3col' ? 3 : 2;
    var startNums = format==='3col' ? [1,rowCount+1,rowCount*2+1] : [1,rowCount+1];

    var minHR = (config.minDigitH || 0.8) / 100;
    var maxHR = (config.maxDigitH || 4.0) / 100;
    var maxWR = (config.maxDigitW || 2.5) / 100;
    var blockPct = config.blockSize || 2.0;
    var xW = config.xWeight || 4;

    log('\n=== PIPELINE v9l (clusters='+numClusters+') ===','phase');
    log('  Image: '+srcMat.cols+'x'+srcMat.rows+' | format='+format+' rows='+rowCount+' maxColW='+maxWP+'%','dim');

    var ccResult = anchorFindCandidates(srcGray, {minHR:minHR, maxHR:maxHR, maxWR:maxWR, blockPct:blockPct}, log);
    var cands = ccResult.cands;
    ccResult.cleaned.delete();

    var clResult = anchorSingleLinkage(cands, xW);
    var clusters = anchorExtractClusters(cands, clResult.edges, numClusters);
    var scored = clusters.map(function(c){return anchorScoreCluster(c, srcMat.rows, srcMat.cols, maxWP, rowCount);});

    // Merge close clusters
    var indexed=clusters.map(function(c,i){return{cl:c,score:scored[i].score};});
    indexed.sort(function(a,b){return b.score-a.score;});
    var good=indexed.filter(function(it){return it.score>0;});
    var mergeT=srcMat.cols*0.04,merged=[],mU=new Array(good.length).fill(false);
    for(var mi=0;mi<good.length;mi++){if(mU[mi])continue;var grp=[good[mi].cl];mU[mi]=true;
        var bx=good[mi].cl.reduce(function(s,c){return s+c.cx;},0)/good[mi].cl.length;
        for(var mj=mi+1;mj<good.length;mj++){if(mU[mj])continue;
            var ox=good[mj].cl.reduce(function(s,c){return s+c.cx;},0)/good[mj].cl.length;
            if(Math.abs(ox-bx)<mergeT){grp.push(good[mj].cl);mU[mj]=true;}}
        var flat=[];grp.forEach(function(g){flat=flat.concat(g);});merged.push(flat);
        if(grp.length>1)log('  Merged '+grp.length+' → '+flat.length,'good');}
    var mS=merged.map(function(c){return anchorScoreCluster(c,srcMat.rows,srcMat.cols,maxWP,rowCount);});
    var mI=merged.map(function(c,i){return{cl:c,score:mS[i].score};});
    mI.sort(function(a,b){return b.score-a.score;});
    var top=mI.slice(0,expCols).filter(function(it){return it.score>0;}).map(function(it){return it.cl;});
    top.sort(function(a,b){return(a.reduce(function(s,c){return s+c.cx;},0)/a.length)-(b.reduce(function(s,c){return s+c.cx;},0)/b.length);});
    log('Selected '+top.length+' columns','good');
    if(top.length<2){log('Need ≥2!','err');ccResult.binary.delete();return null;}

    // Trim clusters that extend into header (sliding window approach from testbed)
    for(var ti=0;ti<top.length;ti++){
        var clSorted = top[ti].slice().sort(function(a,b){return a.cy-b.cy;});
        var avgH = clSorted.reduce(function(s,c){return s+c.h;},0)/clSorted.length;
        var yTol = avgH * 0.6;
        var grps = [[clSorted[0]]];
        for(var gi=1;gi<clSorted.length;gi++){
            var last=grps[grps.length-1];
            if(clSorted[gi].cy - last[last.length-1].cy <= yTol) last.push(clSorted[gi]);
            else grps.push([clSorted[gi]]);
        }
        var rYs = grps.map(function(g){return g.reduce(function(s,c){return s+c.cy;},0)/g.length;});
        var rCounts = grps.map(function(g){return g.length;});

        // Absorb squeezed singletons
        if(rYs.length >= 5) {
            var trimGaps = [];
            for(var tgi=1;tgi<rYs.length;tgi++) trimGaps.push(rYs[tgi]-rYs[tgi-1]);
            var trimMed = trimGaps.slice().sort(function(a,b){return a-b;})[Math.floor(trimGaps.length/2)];
            for(var si=rYs.length-2;si>=1;si--){
                if(rCounts[si] <= 1) {
                    var gapBefore = rYs[si] - rYs[si-1];
                    var gapAfter = rYs[si+1] - rYs[si];
                    var totalGap = gapBefore + gapAfter;
                    if(totalGap < trimMed * 1.4 && totalGap > trimMed * 0.6) {
                        var removedItems = grps[si];
                        for(var ri=0;ri<removedItems.length;ri++){
                            var idx = top[ti].indexOf(removedItems[ri]);
                            if(idx >= 0) top[ti].splice(idx, 1);
                        }
                        log('  Col'+(ti+1)+': remove singleton at y≈'+Math.round(rYs[si]),'dim');
                        rYs.splice(si, 1);
                        rCounts.splice(si, 1);
                        grps.splice(si, 1);
                    }
                }
            }
        }
    }

    // Cross-column Y alignment (sliding window)
    var colGroups = [];
    for(var ai=0;ai<top.length;ai++){
        var aclS = top[ai].slice().sort(function(a,b){return a.cy-b.cy;});
        var aAvgH = aclS.reduce(function(s,c){return s+c.h;},0)/aclS.length;
        var aYTol = aAvgH * 0.6;
        var aGrps = [[aclS[0]]];
        for(var agi=1;agi<aclS.length;agi++){
            var aLast=aGrps[aGrps.length-1];
            if(aclS[agi].cy - aLast[aLast.length-1].cy <= aYTol) aLast.push(aclS[agi]);
            else aGrps.push([aclS[agi]]);
        }
        colGroups.push({
            grps: aGrps,
            ys: aGrps.map(function(g){return g.reduce(function(s,c){return s+c.cy;},0)/g.length;}),
            topY: Math.min.apply(null, aGrps[0].map(function(c){return c.cy;})),
            botY: Math.max.apply(null, aGrps[aGrps.length-1].map(function(c){return c.cy;}))
        });
    }

    function findBestRowWindow(ys, rowCount) {
        if(ys.length <= rowCount) return {topY: ys[0], botY: ys[ys.length-1], start: 0};
        var bestVar = Infinity, bestStart = 0;
        for(var s = 0; s <= ys.length - rowCount; s++) {
            var sps = [];
            for(var i = s+1; i < s+rowCount; i++) sps.push(ys[i]-ys[i-1]);
            var mean = sps.reduce(function(a,b){return a+b;},0) / sps.length;
            var variance = sps.reduce(function(a,b){return a + Math.pow(b-mean,2);},0) / sps.length;
            if(variance < bestVar) { bestVar = variance; bestStart = s; }
        }
        return {topY: ys[bestStart], botY: ys[bestStart + rowCount - 1], start: bestStart, variance: bestVar};
    }

    function medianOf(arr) {
        var s = arr.slice().sort(function(a,b){return a-b;});
        var mid = Math.floor(s.length/2);
        return s.length % 2 === 0 ? (s[mid-1]+s[mid])/2 : s[mid];
    }

    var consensusTops = [], consensusBots = [];
    for(var ci2=0;ci2<colGroups.length;ci2++){
        var cys = colGroups[ci2].ys;
        var win = findBestRowWindow(cys, rowCount);
        consensusTops.push(win.topY);
        consensusBots.push(win.botY);
        if(cys.length > rowCount) {
            log('  Col'+(ci2+1)+': '+cys.length+' groups → window['+win.start+'..'+(win.start+rowCount-1)+']','dim');
        }
    }
    var consensusTop = medianOf(consensusTops);
    var consensusBot = medianOf(consensusBots);
    log('  Y alignment: consensusTop='+Math.round(consensusTop)+' consensusBot='+Math.round(consensusBot),'dim');

    // Validation guard
    var allColSpacings = [];
    for(var csi=0;csi<colGroups.length;csi++){
        var cys2 = colGroups[csi].ys;
        for(var csj=1;csj<cys2.length;csj++){
            var sp = cys2[csj]-cys2[csj-1];
            if(sp > 0) allColSpacings.push(sp);
        }
    }
    var skipTrimming = false;
    if(allColSpacings.length >= 3) {
        var medSpacing = medianOf(allColSpacings);
        var consensusRange = consensusBot - consensusTop;
        var expectedRange = (rowCount - 1) * medSpacing;
        var rangeRatio = consensusRange / expectedRange;
        if(rangeRatio < 0.65 || rangeRatio > 1.5) {
            log('  Y guard FAILED (ratio '+rangeRatio.toFixed(2)+') → skip trimming','warn');
            skipTrimming = true;
        }
    }

    if(!skipTrimming) {
        for(var ti2=0;ti2<top.length;ti2++){
            var cg = colGroups[ti2];
            if(cg.ys.length <= rowCount) continue;
            var medGap = 0;
            if(cg.ys.length >= 3) {
                var aGaps = [];
                for(var aggi=1;aggi<cg.ys.length;aggi++) aGaps.push(cg.ys[aggi]-cg.ys[aggi-1]);
                medGap = aGaps.slice().sort(function(a,b){return a-b;})[Math.floor(aGaps.length/2)];
            }
            var tol = medGap * 0.5;
            var before = top[ti2].length;
            top[ti2] = top[ti2].filter(function(c){
                return c.cy >= consensusTop - tol && c.cy <= consensusBot + tol;
            });
            if(before !== top[ti2].length) {
                log('  Col'+(ti2+1)+': Y-align trim '+before+'→'+top[ti2].length,'good');
            }
        }
    }

    // Build rows
    log('\n[Rows] Building...','phase');
    var colR = top.map(function(cl,i){
        var rows = anchorBuildRowsFromCluster(cl, rowCount);
        log('  Col'+(i+1)+': '+rows.length+' row groups','good');
        return rows;
    });

    // Cross-validate rows (same logic from testbed)
    function crossValidateRows(rowsA, allOtherRows, labelA) {
        if(rowsA.length >= rowCount) return rowsA;
        var refRows = [];
        allOtherRows.forEach(function(rr){refRows=refRows.concat(rr);});
        refRows.sort(function(a,b){return a.y-b.y;});
        var spsA=[];for(var i=1;i<rowsA.length;i++)spsA.push(rowsA[i].y-rowsA[i-1].y);
        if(spsA.length<2) return rowsA;
        var medA=spsA.slice().sort(function(a,b){return a-b;})[Math.floor(spsA.length/2)];
        var spsR=[];for(var j=1;j<refRows.length;j++)spsR.push(refRows[j].y-refRows[j-1].y);
        var medR=spsR.length>=2?spsR.slice().sort(function(a,b){return a-b;})[Math.floor(spsR.length/2)]:medA;
        var med=Math.round((medA+medR)/2);
        var yTol=med*0.4;
        var augmented=rowsA.slice(), added=0;
        for(var gi=0;gi<augmented.length-1 && augmented.length<rowCount;gi++){
            var gap=augmented[gi+1].y-augmented[gi].y;
            if(gap<med*1.5) continue;
            var missing=Math.round(gap/med)-1;
            if(missing<1) continue;
            var gapTop=augmented[gi].y, gapBot=augmented[gi+1].y;
            var refsInGap=refRows.filter(function(r){return r.y>gapTop+yTol && r.y<gapBot-yTol;});
            for(var mi2=0;mi2<missing && augmented.length<rowCount;mi2++){
                var expectedY=gapTop+med*(mi2+1);
                var matchR=null;
                for(var bi=0;bi<refsInGap.length;bi++){
                    if(Math.abs(refsInGap[bi].y-expectedY)<yTol){matchR=refsInGap[bi];break;}
                }
                var newY=matchR?matchR.y:expectedY;
                var newRow={y:newY, x:(augmented[gi].x+augmented[gi+1].x)/2,
                    left:(augmented[gi].left+augmented[gi+1].left)/2, right:(augmented[gi].right+augmented[gi+1].right)/2,
                    top:newY-med*0.3, bottom:newY+med*0.3, interpolated:true, crossValidated:!!matchR, count:0};
                augmented.splice(gi+1+mi2,0,newRow); added++;
            }
        }
        if(augmented.length<rowCount && refRows.length>0) {
            var aTop=augmented[0].y;
            var bAbove=refRows.filter(function(r){return r.y<aTop-yTol;});
            for(var ti=bAbove.length-1;ti>=0 && augmented.length<rowCount;ti--){
                augmented.unshift({y:bAbove[ti].y, x:augmented[0].x, left:augmented[0].left, right:augmented[0].right,
                    top:bAbove[ti].y-med*0.3, bottom:bAbove[ti].y+med*0.3, interpolated:true, crossValidated:true, count:0});
                added++;
            }
            var aBot=augmented[augmented.length-1].y;
            var bBelow=refRows.filter(function(r){return r.y>aBot+yTol;});
            for(var bi2=0;bi2<bBelow.length && augmented.length<rowCount;bi2++){
                augmented.push({y:bBelow[bi2].y, x:augmented[augmented.length-1].x, left:augmented[augmented.length-1].left, right:augmented[augmented.length-1].right,
                    top:bBelow[bi2].y-med*0.3, bottom:bBelow[bi2].y+med*0.3, interpolated:true, crossValidated:true, count:0});
                added++;
            }
        }
        if(added>0) log('  '+labelA+': '+rowsA.length+' → '+augmented.length+' rows (+'+added+')','good');
        if(augmented.length>rowCount) augmented=augmented.slice(0,rowCount);
        return augmented;
    }

    var anyShort = colR.some(function(r){return r.length<rowCount;});
    if(anyShort) {
        log('\n[Cross-validate] Augmenting...','phase');
        for(var cvi=0;cvi<colR.length;cvi++){
            var others=colR.filter(function(_,j){return j!==cvi;});
            colR[cvi] = crossValidateRows(colR[cvi], others, 'Col'+(cvi+1));
        }
    }

    // Extrapolate if still short
    function extrapolateRows(rows, allRows, label) {
        if(rows.length >= rowCount) return rows;
        var sps=[];for(var i=1;i<rows.length;i++)sps.push(rows[i].y-rows[i-1].y);
        if(sps.length<2) return rows;
        var med=sps.slice().sort(function(a,b){return a-b;})[Math.floor(sps.length/2)];
        var allYs=[];allRows.forEach(function(rr){rr.forEach(function(r){allYs.push(r.y);});});
        var gridTop=Math.min.apply(null,allYs), gridBot=Math.max.apply(null,allYs);
        var added=0;
        while(rows.length<rowCount){
            var topGap=rows[0].y-gridTop, botGap=gridBot-rows[rows.length-1].y;
            if(topGap>med*0.5 && topGap>=botGap){
                var nY=rows[0].y-med;
                rows.unshift({y:nY,x:rows[0].x,left:rows[0].left,right:rows[0].right,top:nY-med*0.3,bottom:nY+med*0.3,interpolated:true,count:0});added++;
            } else {
                var expectedTopY=gridBot-(rowCount-1)*med;
                if(rows[0].y>expectedTopY+med*0.3){
                    var nYt=rows[0].y-med;
                    rows.unshift({y:nYt,x:rows[0].x,left:rows[0].left,right:rows[0].right,top:nYt-med*0.3,bottom:nYt+med*0.3,interpolated:true,count:0});added++;
                } else {
                    var nYb=rows[rows.length-1].y+med;
                    rows.push({y:nYb,x:rows[rows.length-1].x,left:rows[rows.length-1].left,right:rows[rows.length-1].right,top:nYb-med*0.3,bottom:nYb+med*0.3,interpolated:true,count:0});added++;
                }
            }
        }
        if(added>0) log('  '+label+': extrapolated +'+added,'good');
        return rows;
    }

    anyShort = colR.some(function(r){return r.length<rowCount;});
    if(anyShort) {
        for(var exi=0;exi<colR.length;exi++)
            colR[exi] = extrapolateRows(colR[exi], colR, 'Col'+(exi+1));
    }
    log('  Final: '+colR.map(function(r,i){return 'Col'+(i+1)+'='+r.length;}).join(', '),'good');

    // Compute warp corners
    log('\n[Warp] Computing corners from anchor positions...','phase');
    var corners=anchorComputeWarpCorners(colR,rowCount,srcMat.cols,srcMat.rows,format);
    if(!corners){log('Cannot compute corners!','err');ccResult.binary.delete();return null;}

    // Perspective warp
    var warped=anchorPerspectiveWarp(srcMat,corners);
    log('  Warped: '+warped.cols+'x'+warped.rows,'good');

    // Column detection on warped
    log('\n[Columns] Zugwise n/w/w on warped...','phase');
    var wGray=new cv.Mat();cv.cvtColor(warped,wGray,cv.COLOR_RGBA2GRAY);
    var expectedFracs;
    if(format==='3col') {
        var u=1/16.2;
        expectedFracs=[0, 1*u, 3.2*u, 5.4*u, 6.4*u, 8.6*u, 10.8*u, 11.8*u, 14*u, 1.0];
    } else {
        expectedFracs=[0, 1/11, 3.3/11, 5.5/11, 6.5/11, 8.8/11, 1.0];
    }
    var colRes=anchorDetectColumns(wGray,format,log,expectedFracs);

    // Row detection on warped
    log('\n[Rows] Guided row detection on warped...','phase');
    var rowLines=anchorDetectRows(wGray,colRes.boundaries,rowCount,log,format);
    wGray.delete();

    // Extract cells
    log('\n[Extract] Cells from warped...','phase');
    var cells=anchorExtractCells(warped,colRes.boundaries,rowLines,startNums,rowCount,format);
    log('  '+cells.length+' cells','good');

    ccResult.binary.delete();

    return {
        corners: corners,
        warped: warped,
        colBounds: colRes.boundaries,
        rowLines: rowLines,
        cells: cells,
        colRows: colR,
        method: 'anchor'
    };
}

// =============================================================================
// TOP-LEVEL: smartCrop → colorFilter → autoFind → runPipeline
// =============================================================================
function anchorProcessScoresheet(srcMat, config, log) {
    var srcGray = new cv.Mat();
    cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);

    // Smart crop
    var crop = anchorSmartCrop(srcGray, log);
    var croppedMat, croppedGray;
    if (crop.cropped) {
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
        var cfResult = anchorStripColors(croppedMat, config.satThreshold || 50, log);
        croppedMat.delete();
        croppedMat = cfResult.cleaned;
        croppedGray.delete();
        croppedGray = new cv.Mat();
        cv.cvtColor(croppedMat, croppedGray, cv.COLOR_RGBA2GRAY);
    }

    // Auto-find best clustering parameters
    var autoResult = anchorAutoFind(croppedGray, config, log);

    if (autoResult.bestResult.bestScore < 0) {
        log('Anchor detection failed — no valid column clusters found','err');
        croppedMat.delete();
        croppedGray.delete();
        return null;
    }

    // Run full pipeline with auto-calibrated parameters
    var pipelineConfig = {
        format: config.format || '2col',
        rowCount: config.rowCount || 20,
        numClusters: autoResult.bestN,
        maxColWidthPct: config.maxColWidthPct || 7,
        minDigitH: autoResult.bestMinH,
        maxDigitH: config.maxDigitH || 4.0,
        maxDigitW: autoResult.bestMaxW,
        blockSize: config.blockSize || 2.0,
        xWeight: autoResult.bestXW
    };

    var result = anchorRunPipeline(croppedMat, croppedGray, pipelineConfig, log);

    croppedMat.delete();
    croppedGray.delete();

    return result;
}

// =============================================================================
// EXPORTS
// =============================================================================
if (typeof window !== 'undefined') {
    window.AnchorGrid = {
        anchorSmartCrop: anchorSmartCrop,
        anchorStripColors: anchorStripColors,
        anchorFindCandidates: anchorFindCandidates,
        anchorSingleLinkage: anchorSingleLinkage,
        anchorExtractClusters: anchorExtractClusters,
        anchorScoreCluster: anchorScoreCluster,
        anchorAutoFindBestCut: anchorAutoFindBestCut,
        anchorBuildRowsFromCluster: anchorBuildRowsFromCluster,
        anchorComputeWarpCorners: anchorComputeWarpCorners,
        anchorPerspectiveWarp: anchorPerspectiveWarp,
        anchorScoreColumnPattern: anchorScoreColumnPattern,
        anchorIsWideBalanced: anchorIsWideBalanced,
        anchorDetectColumns: anchorDetectColumns,
        anchorDetectRows: anchorDetectRows,
        anchorExtractCells: anchorExtractCells,
        anchorAutoFind: anchorAutoFind,
        anchorRunPipeline: anchorRunPipeline,
        anchorProcessScoresheet: anchorProcessScoresheet
    };
}
