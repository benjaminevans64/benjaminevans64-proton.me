/* catalog.js — sort dropdown and minor UI enhancements */
(function(){
    'use strict';

    // Smooth scroll pagination links to top of catalog
    document.querySelectorAll('.catalog-pagination a').forEach(function(a) {
        a.addEventListener('click', function() {
            setTimeout(function() {
                var hero = document.querySelector('.catalog-hero');
                if (hero) hero.scrollIntoView({ behavior: 'smooth' });
            }, 100);
        });
    });

    // Lazy reveal cards with subtle animation
    var cards = document.querySelectorAll('.psychic-card');
    if ('IntersectionObserver' in window && cards.length) {
        cards.forEach(function(c) { c.style.opacity = '0'; c.style.transform = 'translateY(12px)'; });
        var obs = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var el = entry.target;
                    el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';
                    obs.unobserve(el);
                }
            });
        }, { threshold: 0.1 });
        cards.forEach(function(c) { obs.observe(c); });
    }
})();
