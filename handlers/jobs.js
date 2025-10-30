// handlers/jobs.js
'use strict';
const { sendJSON } = require('../utils/http');
function handleJobSubmit(_req,res){ return sendJSON(res,501,{ok:false,error:'job_submit_not_implemented'}); }
function handleJobsList(_req,res){ return sendJSON(res,200,{ok:true,state:'queue',count:0,items:[]}); }
function handleJobsLog(_req,res){ return sendJSON(res,404,{ok:false,error:'not_found'}); }
module.exports = { handleJobSubmit, handleJobsList, handleJobsLog };

