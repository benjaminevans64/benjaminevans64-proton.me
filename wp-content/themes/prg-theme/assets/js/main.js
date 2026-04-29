document.addEventListener('DOMContentLoaded',function(){
var t=document.querySelector('.hdr__toggle'),n=document.querySelector('.hdr__nav');
if(t&&n)t.addEventListener('click',function(){var o=n.classList.toggle('active');t.setAttribute('aria-expanded',o);t.querySelector('.hdr__toggle-open').style.display=o?'none':'block';t.querySelector('.hdr__toggle-close').style.display=o?'block':'none'});
document.querySelectorAll('.faq-row__q').forEach(function(b){b.addEventListener('click',function(){var r=b.closest('.faq-row'),w=r.classList.contains('open');document.querySelectorAll('.faq-row').forEach(function(x){x.classList.remove('open');x.querySelector('.faq-row__q').setAttribute('aria-expanded','false')});if(!w){r.classList.add('open');b.setAttribute('aria-expanded','true')}})});
});