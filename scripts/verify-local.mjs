#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.QUOTING_TEST_API || 'http://127.0.0.1:4100/api/v1';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('This smoke test creates fixtures and only supports localhost.');
const stamp = randomUUID().slice(0, 8);
function client() {
 let cookie='';
 return async (path,method='GET',body) => {
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),origin:'http://localhost:3100'},...(body?{body:JSON.stringify(body)}:{})});
  if (response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
  const payload=await response.json();
  return {status:response.status,data:payload.data,error:payload.error};
 };
}
const owner=client(), stranger=client();
const check=(name,test)=>{assert.ok(test,name);console.log('PASS',name);};
const registered=await owner('/auth/register','POST',{name:'QA Owner',email:`qa-${stamp}@example.test`,password:`Quotient-${stamp}-secure!`,businessName:`QA Pressure Washing ${stamp}`});
check('Account registration',registered.status===201||registered.status===200);
const tenantId=registered.data?.business?.id;
check('Tenant identity exists',typeof tenantId==='string');
check('Cookie authentication',(await owner('/auth/me')).data?.user?.email===`qa-${stamp}@example.test`);
const unauth=await client()('/dashboard');check('Anonymous owner access rejected',unauth.status===401);
const serviceResult=await owner('/services','POST',{name:'QA driveway cleaning',description:'Routine concrete driveway cleaning',unitLabel:'sq ft',unitPriceCents:20,minimumChargeCents:15000,basePriceCents:0,maxAutoQuoteCents:100000,requiredInputs:['quantity'],exclusions:['roof cleaning'],mode:'review'});
check('Create pricing service',serviceResult.status===201||serviceResult.status===200);
const service=serviceResult.data;
const example=await owner('/examples','POST',{serviceId:service.id,title:'QA standard driveway',description:'1000 sq ft concrete driveway, easy access',quantity:1000,finalPriceCents:20000,rationale:'1000 sq ft at $0.20 each',source:'historical'});
check('Historical case persists',example.status===201||example.status===200);
const example2=await owner('/examples','POST',{serviceId:service.id,title:'QA small driveway',description:'500 sq ft concrete driveway',quantity:500,finalPriceCents:15000,rationale:'Minimum visit charge applies',source:'historical'});
check('Minimum-price case persists',example2.status===201||example2.status===200);
const price=await owner('/playground','POST',{serviceId:service.id,quantity:1000,description:'1000 sq ft concrete driveway, easy access'});
check('Server-calculated price',price.data?.quote?.totalCents===20000);
const minimum=await owner('/playground','POST',{serviceId:service.id,quantity:100,description:'Small concrete driveway'});
check('Minimum charge enforced',minimum.data?.quote?.totalCents===15000);
const invalid=await owner('/playground','POST',{serviceId:service.id,quantity:-10,description:'Invalid request'});
check('Invalid quantities rejected',invalid.status>=400&&invalid.status<500);
const usage=await owner('/usage');check('Owner playground is nonbillable',usage.data?.billableQuotes===0);
const registeredOther=await stranger('/auth/register','POST',{name:'Other QA Owner',email:`qa-other-${stamp}@example.test`,password:`Quotient-${stamp}-other!`,businessName:`Other QA ${stamp}`});
check('Second tenant account',registeredOther.status===201||registeredOther.status===200);
const forbidden=await stranger(`/services/${service.id}`,'PATCH',{name:'Unauthorized edit'});
check('Cross-tenant service mutation denied',forbidden.status===404||forbidden.status===403);
const strangerCases=await stranger('/examples');check('Cross-tenant examples isolated',Array.isArray(strangerCases.data)&&strangerCases.data.length===0);
const evaluation=await owner(`/services/${service.id}/evaluate`,'POST',{});
check('Pricing evaluation returns checks',Array.isArray(evaluation.data?.checks));
const dashboard=await owner('/dashboard');check('Dashboard reports real case counts',dashboard.data?.stats?.examplesCount===2);
await owner('/auth/logout','POST',{});
check('Logout revokes session',(await owner('/auth/me')).status===401);
console.log(JSON.stringify({result:'PASS',fixtureBusinessIds:[tenantId,registeredOther.data?.business?.id],serviceId:service.id},null,2));
